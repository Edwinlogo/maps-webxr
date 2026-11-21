import * as THREE from 'three';

export interface XRControllerCallbacks {
  onSelectRay: (raycaster: THREE.Raycaster, handedness: string) => void;
  onLeftStick: (x: number, y: number, dt: number) => void;
  onRightStick: (x: number, y: number, dt: number) => void;
  onSnapTurn: (dir: -1 | 1) => void;
  onWalkForward: () => void;
  onButtonA: () => void;
  onButtonB: () => void;
  onButtonX: () => void;
  onSingleGripDrag: (deltaWorld: THREE.Vector3) => void;
  onTwoHandZoom: (distanceRatio: number) => void;
}

interface ControllerSlot {
  index: number;
  raySpace: THREE.XRTargetRaySpace;
  gripSpace: THREE.XRGripSpace;
  laserLine: THREE.Line;
  laserMat: THREE.LineBasicMaterial;
  reticleDot: THREE.Mesh;
  handedness: string;
  inputSource: XRInputSource | null;
  squeezing: boolean;
  lastGripPos: THREE.Vector3;
}

function buildQuestControllerMesh(): THREE.Group {
  const group = new THREE.Group();

  // Handle grip
  const handleGeo = new THREE.CylinderGeometry(0.017, 0.014, 0.11, 14);
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.45,
    metalness: 0.1,
  });
  const handle = new THREE.Mesh(handleGeo, bodyMat);
  handle.rotation.x = Math.PI * 0.25;
  handle.position.set(0, -0.025, 0.035);
  group.add(handle);

  // Faceplate top (Meta Quest 3 Touch Plus ringless dark faceplate!)
  const faceGeo = new THREE.CylinderGeometry(0.028, 0.024, 0.016, 20);
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.3,
    metalness: 0.2,
  });
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(0, 0.012, -0.008);
  group.add(face);

  // Subtle glowing cyan accent ring
  const accentGeo = new THREE.TorusGeometry(0.026, 0.0022, 8, 24);
  const accentMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  const accent = new THREE.Mesh(accentGeo, accentMat);
  accent.rotation.x = Math.PI / 2;
  accent.position.set(0, 0.02, -0.008);
  group.add(accent);

  return group;
}

export class XRControllerManager {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private callbacks: XRControllerCallbacks;
  private slots: ControllerSlot[] = [];

  private prevTwoHandDist: number | null = null;
  private prevButtonA = false;
  private prevButtonB = false;
  private prevButtonX = false;
  private snapCooldown = 0;
  private walkCooldown = 0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPosA = new THREE.Vector3();
  private readonly tmpPosB = new THREE.Vector3();
  private readonly tmpDelta = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, callbacks: XRControllerCallbacks) {
    this.renderer = renderer;
    this.scene = scene;
    this.callbacks = callbacks;

    for (let i = 0; i < 2; i++) {
      const raySpace = renderer.xr.getController(i);
      const gripSpace = renderer.xr.getControllerGrip(i);

      const laserGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -6),
      ]);
      const laserMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.8,
      });
      const laserLine = new THREE.Line(laserGeo, laserMat);
      laserLine.renderOrder = 45;
      raySpace.add(laserLine);

      const dotGeo = new THREE.SphereGeometry(0.011, 12, 10);
      const dotMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        depthTest: false,
      });
      const reticleDot = new THREE.Mesh(dotGeo, dotMat);
      reticleDot.visible = false;
      reticleDot.renderOrder = 50;
      scene.add(reticleDot);

      gripSpace.add(buildQuestControllerMesh());
      scene.add(raySpace);
      scene.add(gripSpace);

      const slot: ControllerSlot = {
        index: i,
        raySpace,
        gripSpace,
        laserLine,
        laserMat,
        reticleDot,
        handedness: i === 0 ? 'left' : 'right',
        inputSource: null,
        squeezing: false,
        lastGripPos: new THREE.Vector3(),
      };

      raySpace.addEventListener('connected', (ev) => {
        const src = (ev as unknown as { data?: XRInputSource }).data ?? null;
        slot.inputSource = src;
        if (src?.handedness) slot.handedness = src.handedness;
        slot.laserLine.visible = true;
      });

      raySpace.addEventListener('disconnected', () => {
        slot.inputSource = null;
        slot.squeezing = false;
        slot.reticleDot.visible = false;
      });

      raySpace.addEventListener('selectstart', () => {
        this.pulseHaptic(slot, 0.35, 25);
        this.buildRayFromSpace(slot.raySpace, this.raycaster);
        this.callbacks.onSelectRay(this.raycaster, slot.handedness);
      });

      raySpace.addEventListener('squeezestart', () => {
        slot.squeezing = true;
        slot.gripSpace.getWorldPosition(slot.lastGripPos);
        this.prevTwoHandDist = null;
      });

      raySpace.addEventListener('squeezeend', () => {
        slot.squeezing = false;
        this.prevTwoHandDist = null;
      });

      this.slots.push(slot);
    }
  }

  public getRaycasterForSlot(index: number): THREE.Raycaster | null {
    const slot = this.slots[index];
    if (!slot || !slot.inputSource) return null;
    this.buildRayFromSpace(slot.raySpace, this.raycaster);
    return this.raycaster;
  }

  public setSlotHitFeedback(index: number, hitPoint: THREE.Vector3 | null, highlight = false): void {
    const slot = this.slots[index];
    if (!slot) return;
    if (hitPoint) {
      slot.reticleDot.position.copy(hitPoint);
      slot.reticleDot.visible = true;
      slot.laserMat.color.setHex(highlight ? 0x34d399 : 0x38bdf8);
      const origin = new THREE.Vector3();
      slot.raySpace.getWorldPosition(origin);
      const dist = Math.max(0.15, Math.min(12, origin.distanceTo(hitPoint)));
      const posAttr = slot.laserLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(1, 0, 0, -dist);
      posAttr.needsUpdate = true;
    } else {
      slot.reticleDot.visible = false;
      slot.laserMat.color.setHex(0x38bdf8);
      const posAttr = slot.laserLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(1, 0, 0, -5.5);
      posAttr.needsUpdate = true;
    }
  }

  public pulseAllHaptics(strength = 0.45, durationMs = 40): void {
    for (const slot of this.slots) {
      this.pulseHaptic(slot, strength, durationMs);
    }
  }

  private pulseHaptic(slot: ControllerSlot, strength: number, durationMs: number): void {
    try {
      const gp = slot.inputSource?.gamepad as (Gamepad & {
        hapticActuators?: Array<{ pulse?: (v: number, d: number) => void }>;
      }) | undefined;
      gp?.hapticActuators?.[0]?.pulse?.(strength, durationMs);
    } catch {
      // Haptics optional
    }
  }

  private buildRayFromSpace(space: THREE.Object3D, out: THREE.Raycaster): void {
    this.tmpMatrix.identity().extractRotation(space.matrixWorld);
    out.ray.origin.setFromMatrixPosition(space.matrixWorld);
    out.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix).normalize();
  }

  public update(dt: number, isStreetView: boolean): void {
    const session = this.renderer.xr.getSession();
    if (!session) {
      for (const s of this.slots) s.reticleDot.visible = false;
      return;
    }

    this.snapCooldown = Math.max(0, this.snapCooldown - dt);
    this.walkCooldown = Math.max(0, this.walkCooldown - dt);

    // 1) Process Meta Quest 3 Touch Plus gamepad thumbsticks & A/B/X/Y buttons
    let buttonADown = false;
    let buttonBDown = false;
    let buttonXDown = false;

    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp) continue;

      const axes = gp.axes;
      const sx = axes.length >= 4 ? axes[2] : axes[0] ?? 0;
      const sy = axes.length >= 4 ? axes[3] : axes[1] ?? 0;
      const deadzone = 0.16;
      const ax = Math.abs(sx) > deadzone ? sx : 0;
      const ay = Math.abs(sy) > deadzone ? sy : 0;

      if (source.handedness === 'left') {
        if (ax !== 0 || ay !== 0) {
          this.callbacks.onLeftStick(ax, ay, dt);
        }
        if (isStreetView && sy < -0.68 && this.walkCooldown <= 0) {
          this.walkCooldown = 0.7;
          this.callbacks.onWalkForward();
        }
        if (gp.buttons[4]?.pressed) buttonXDown = true; // X button
        if (gp.buttons[5]?.pressed) buttonBDown = true; // Y button also exits Street View
      } else if (source.handedness === 'right') {
        if (ax !== 0 || ay !== 0) {
          this.callbacks.onRightStick(ax, ay, dt);
        }
        if (isStreetView && Math.abs(sx) > 0.68 && this.snapCooldown <= 0) {
          this.snapCooldown = 0.34;
          this.callbacks.onSnapTurn(sx > 0 ? 1 : -1);
        }
        if (gp.buttons[4]?.pressed) buttonADown = true; // A button
        if (gp.buttons[5]?.pressed) buttonBDown = true; // B button
      }
    }

    // Rising-edge button events
    if (buttonADown && !this.prevButtonA) this.callbacks.onButtonA();
    if (buttonBDown && !this.prevButtonB) this.callbacks.onButtonB();
    if (buttonXDown && !this.prevButtonX) this.callbacks.onButtonX();
    this.prevButtonA = buttonADown;
    this.prevButtonB = buttonBDown;
    this.prevButtonX = buttonXDown;

    // 2) Grip grab / two-hand pinch-zoom gestures in Globe mode
    if (!isStreetView) {
      const s0 = this.slots[0];
      const s1 = this.slots[1];
      if (s0.squeezing && s1.squeezing) {
        s0.gripSpace.getWorldPosition(this.tmpPosA);
        s1.gripSpace.getWorldPosition(this.tmpPosB);
        const dist = this.tmpPosA.distanceTo(this.tmpPosB);
        if (this.prevTwoHandDist !== null && this.prevTwoHandDist > 0.05 && dist > 0.05) {
          const ratio = this.prevTwoHandDist / dist;
          if (Math.abs(ratio - 1) > 0.002) {
            this.callbacks.onTwoHandZoom(ratio);
          }
        }
        this.prevTwoHandDist = dist;
        s0.lastGripPos.copy(this.tmpPosA);
        s1.lastGripPos.copy(this.tmpPosB);
      } else {
        this.prevTwoHandDist = null;
        const activeGrip = s0.squeezing ? s0 : s1.squeezing ? s1 : null;
        if (activeGrip) {
          activeGrip.gripSpace.getWorldPosition(this.tmpPosA);
          this.tmpDelta.subVectors(this.tmpPosA, activeGrip.lastGripPos);
          if (this.tmpDelta.lengthSq() > 0.000001) {
            this.callbacks.onSingleGripDrag(this.tmpDelta);
          }
          activeGrip.lastGripPos.copy(this.tmpPosA);
        }
      }
    }
  }
}
