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
  onRotateViewDrag: (deltaWorld: THREE.Vector3) => void;
  onTwoHandZoom: (distanceRatio: number) => void;
  onTestPanelGrab: (raycaster: THREE.Raycaster) => { point: THREE.Vector3; distance: number } | null;
  onTestPanelBody: (raycaster: THREE.Raycaster) => boolean;
  onPanelDragMove: (worldPos: THREE.Vector3) => void;
  onPanelDragEnd: () => void;
}

interface ControllerSlot {
  index: number;
  raySpace: THREE.XRTargetRaySpace;
  gripSpace: THREE.XRGripSpace;
  handSpace: THREE.XRHandSpace;
  controllerMesh: THREE.Group;
  handVisualGroup: THREE.Group;
  thumbRing: THREE.Mesh;
  indexRing: THREE.Mesh;
  pinchOrb: THREE.Mesh;
  jointDots: Map<string, THREE.Mesh>;
  laserLine: THREE.Line;
  laserMat: THREE.LineBasicMaterial;
  reticleDot: THREE.Mesh;
  handedness: string;
  inputSource: XRInputSource | null;
  isHand: boolean;

  // Unified pinch / trigger state (supports bare hands + controllers!)
  selectActive: boolean;
  handPinchActive: boolean;
  squeezing: boolean;
  isDraggingPanel: boolean;
  isClickingPanel: boolean;
  panelGrabDistance: number;
  isDraggingView: boolean;
  dragStartPos: THREE.Vector3;
  lastDragPos: THREE.Vector3;
  selectStartMs: number;
  pinchWorldPos: THREE.Vector3;
}

const PINCH_START_DIST = 0.025; // 2.5 cm to initiate pinch
const PINCH_END_DIST = 0.039;   // 3.9 cm hysteresis to release cleanly
const DRAG_THRESHOLD_M = 0.018; // 1.8 cm hand movement switches from tap to rotate-drag

const VISIBLE_HAND_JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
];

function buildQuestControllerMesh(): THREE.Group {
  const group = new THREE.Group();

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

  const faceGeo = new THREE.CylinderGeometry(0.028, 0.024, 0.016, 20);
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    roughness: 0.3,
    metalness: 0.2,
  });
  const face = new THREE.Mesh(faceGeo, faceMat);
  face.position.set(0, 0.012, -0.008);
  group.add(face);

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
  private callbacks: XRControllerCallbacks;
  private slots: ControllerSlot[] = [];

  private passthroughActive = false;
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
  private readonly tmpTarget = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, callbacks: XRControllerCallbacks) {
    this.renderer = renderer;
    this.callbacks = callbacks;

    const tipGeo = new THREE.SphereGeometry(0.0075, 12, 10);
    const pinchGeo = new THREE.SphereGeometry(0.013, 14, 12);
    const jointGeo = new THREE.SphereGeometry(0.0048, 8, 8);

    for (let i = 0; i < 2; i++) {
      const raySpace = renderer.xr.getController(i);
      const gripSpace = renderer.xr.getControllerGrip(i);
      const handSpace = renderer.xr.getHand(i);

      const laserGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -5),
      ]);
      const laserMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.72,
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

      const controllerMesh = buildQuestControllerMesh();
      gripSpace.add(controllerMesh);

      // Minimalist Hand Tracking feedback (clean glowing fingertip indicators + pinch orb!)
      const handVisualGroup = new THREE.Group();
      const thumbRing = new THREE.Mesh(
        tipGeo,
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
      );
      const indexRing = new THREE.Mesh(
        tipGeo,
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85 })
      );
      const pinchOrb = new THREE.Mesh(
        pinchGeo,
        new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.92 })
      );
      thumbRing.visible = false;
      indexRing.visible = false;
      pinchOrb.visible = false;
      handVisualGroup.add(thumbRing, indexRing, pinchOrb);

      const jointDots = new Map<string, THREE.Mesh>();
      const jointMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        transparent: true,
        opacity: 0.55,
      });
      for (const jName of VISIBLE_HAND_JOINTS) {
        const dot = new THREE.Mesh(jointGeo, jointMat);
        dot.visible = false;
        handVisualGroup.add(dot);
        jointDots.set(jName, dot);
      }

      scene.add(raySpace);
      scene.add(gripSpace);
      scene.add(handSpace);
      scene.add(handVisualGroup);

      const slot: ControllerSlot = {
        index: i,
        raySpace,
        gripSpace,
        handSpace,
        controllerMesh,
        handVisualGroup,
        thumbRing,
        indexRing,
        pinchOrb,
        jointDots,
        laserLine,
        laserMat,
        reticleDot,
        handedness: i === 0 ? 'left' : 'right',
        inputSource: null,
        isHand: false,
        selectActive: false,
        handPinchActive: false,
        squeezing: false,
        isDraggingPanel: false,
        isClickingPanel: false,
        panelGrabDistance: 1.0,
        isDraggingView: false,
        dragStartPos: new THREE.Vector3(),
        lastDragPos: new THREE.Vector3(),
        selectStartMs: 0,
        pinchWorldPos: new THREE.Vector3(),
      };

      raySpace.addEventListener('connected', (ev) => {
        const src = (ev as unknown as { data?: XRInputSource }).data ?? null;
        slot.inputSource = src;
        slot.isHand = Boolean(src?.hand);
        if (src?.handedness) slot.handedness = src.handedness;
        slot.controllerMesh.visible = !slot.isHand;
        slot.laserLine.visible = true;
      });

      raySpace.addEventListener('disconnected', () => {
        slot.inputSource = null;
        slot.isHand = false;
        slot.selectActive = false;
        slot.handPinchActive = false;
        slot.squeezing = false;
        slot.isDraggingPanel = false;
        slot.isClickingPanel = false;
        slot.isDraggingView = false;
        slot.reticleDot.visible = false;
        slot.thumbRing.visible = false;
        slot.indexRing.visible = false;
        slot.pinchOrb.visible = false;
        for (const d of slot.jointDots.values()) d.visible = false;
      });

      // Unified selectstart: handles both bare-hand pinch AND controller trigger!
      raySpace.addEventListener('selectstart', () => {
        this.beginPrimarySelect(slot);
      });

      raySpace.addEventListener('selectend', () => {
        this.endPrimarySelect(slot);
      });

      // Controller Grip / Squeeze also supports panel grab + planet rotate + two-hand zoom
      raySpace.addEventListener('squeezestart', () => {
        slot.squeezing = true;
        this.buildRayFromSpace(slot.raySpace, this.raycaster);
        const panelHit = this.callbacks.onTestPanelGrab(this.raycaster);
        if (panelHit) {
          slot.isDraggingPanel = true;
          slot.panelGrabDistance = panelHit.distance;
        } else {
          this.getInteractionPoint(slot, slot.lastDragPos);
        }
        this.prevTwoHandDist = null;
      });

      raySpace.addEventListener('squeezeend', () => {
        slot.squeezing = false;
        if (slot.isDraggingPanel) {
          slot.isDraggingPanel = false;
          this.callbacks.onPanelDragEnd();
        }
        this.prevTwoHandDist = null;
      });

      this.slots.push(slot);
    }
  }

  public setPassthroughMode(enabled: boolean): void {
    this.passthroughActive = enabled;
  }

  private beginPrimarySelect(slot: ControllerSlot): void {
    if (slot.selectActive) return;
    slot.selectActive = true;
    slot.selectStartMs = performance.now();
    slot.isDraggingView = false;
    this.pulseHaptic(slot, 0.3, 22);

    this.buildRayFromSpace(slot.raySpace, this.raycaster);
    const panelHit = this.callbacks.onTestPanelGrab(this.raycaster);
    if (panelHit) {
      slot.isDraggingPanel = true;
      slot.panelGrabDistance = panelHit.distance;
      return;
    }

    if (this.callbacks.onTestPanelBody(this.raycaster)) {
      slot.isClickingPanel = true;
      return;
    }

    this.getInteractionPoint(slot, slot.dragStartPos);
    slot.lastDragPos.copy(slot.dragStartPos);
    this.prevTwoHandDist = null;
  }

  private endPrimarySelect(slot: ControllerSlot): void {
    if (!slot.selectActive) return;
    slot.selectActive = false;

    if (slot.isDraggingPanel) {
      slot.isDraggingPanel = false;
      this.callbacks.onPanelDragEnd();
      return;
    }

    if (slot.isClickingPanel) {
      slot.isClickingPanel = false;
      this.buildRayFromSpace(slot.raySpace, this.raycaster);
      this.callbacks.onSelectRay(this.raycaster, slot.handedness);
      return;
    }

    const wasDragging = slot.isDraggingView;
    slot.isDraggingView = false;
    this.prevTwoHandDist = null;

    // Short pinch/trigger without dragging -> treat as clean Click/Tap!
    if (!wasDragging) {
      this.buildRayFromSpace(slot.raySpace, this.raycaster);
      this.callbacks.onSelectRay(this.raycaster, slot.handedness);
    }
  }

  private getInteractionPoint(slot: ControllerSlot, out: THREE.Vector3): THREE.Vector3 {
    if (slot.isHand && slot.pinchWorldPos.lengthSq() > 0.0001) {
      out.copy(slot.pinchWorldPos);
      return out;
    }
    if (slot.isHand) {
      slot.raySpace.getWorldPosition(out);
      return out;
    }
    slot.gripSpace.getWorldPosition(out);
    return out;
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
      slot.laserMat.color.setHex(slot.isDraggingPanel ? 0x34d399 : highlight ? 0x34d399 : 0x38bdf8);
      const origin = new THREE.Vector3();
      slot.raySpace.getWorldPosition(origin);
      const dist = Math.max(0.15, Math.min(12, origin.distanceTo(hitPoint)));
      const posAttr = slot.laserLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(1, 0, 0, -dist);
      posAttr.needsUpdate = true;
    } else {
      slot.reticleDot.visible = false;
      slot.laserMat.color.setHex(slot.selectActive ? 0x34d399 : 0x38bdf8);
      const posAttr = slot.laserLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(1, 0, 0, -4.5);
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
      const gp = slot.inputSource?.gamepad as
        | (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, d: number) => void }> })
        | undefined;
      gp?.hapticActuators?.[0]?.pulse?.(strength, durationMs);
    } catch {
      // Optional
    }
  }

  private buildRayFromSpace(space: THREE.Object3D, out: THREE.Raycaster): void {
    this.tmpMatrix.identity().extractRotation(space.matrixWorld);
    out.ray.origin.setFromMatrixPosition(space.matrixWorld);
    out.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix).normalize();
  }

  private updateHandJointsAndPinch(slot: ControllerSlot): void {
    if (!slot.isHand) {
      slot.thumbRing.visible = false;
      slot.indexRing.visible = false;
      slot.pinchOrb.visible = false;
      for (const d of slot.jointDots.values()) d.visible = false;
      return;
    }

    const joints = (slot.handSpace as unknown as {
      joints?: Record<string, THREE.Object3D & { jointRadius?: number }>;
    }).joints;
    if (!joints) return;

    const thumbTip = joints['thumb-tip'];
    const indexTip = joints['index-finger-tip'];

    // In Space mode show sleek minimal constellation joints; in Passthrough show only clean fingertip indicators
    for (const [jName, dot] of slot.jointDots) {
      const jObj = joints[jName];
      if (!this.passthroughActive && jObj && jObj.visible) {
        jObj.getWorldPosition(dot.position);
        dot.visible = true;
      } else {
        dot.visible = false;
      }
    }

    if (thumbTip && indexTip && thumbTip.visible && indexTip.visible) {
      thumbTip.getWorldPosition(this.tmpPosA);
      indexTip.getWorldPosition(this.tmpPosB);
      const pinchDist = this.tmpPosA.distanceTo(this.tmpPosB);

      slot.pinchWorldPos.addVectors(this.tmpPosA, this.tmpPosB).multiplyScalar(0.5);
      slot.thumbRing.position.copy(this.tmpPosA);
      slot.indexRing.position.copy(this.tmpPosB);
      slot.pinchOrb.position.copy(slot.pinchWorldPos);

      // Direct joint pinch detection with hysteresis (triggers even if OS delays selectstart!)
      if (!slot.handPinchActive && pinchDist < PINCH_START_DIST) {
        slot.handPinchActive = true;
        this.beginPrimarySelect(slot);
      } else if (slot.handPinchActive && pinchDist > PINCH_END_DIST) {
        slot.handPinchActive = false;
        this.endPrimarySelect(slot);
      }

      const pinched = slot.handPinchActive || slot.selectActive;
      slot.pinchOrb.visible = pinched;
      slot.thumbRing.visible = !pinched;
      slot.indexRing.visible = !pinched;
    } else {
      slot.thumbRing.visible = false;
      slot.indexRing.visible = false;
      slot.pinchOrb.visible = false;
    }
  }

  public update(dt: number, isStreetView: boolean): void {
    const session = this.renderer.xr.getSession();
    if (!session) {
      for (const s of this.slots) {
        s.reticleDot.visible = false;
        s.thumbRing.visible = false;
        s.indexRing.visible = false;
        s.pinchOrb.visible = false;
      }
      return;
    }

    this.snapCooldown = Math.max(0, this.snapCooldown - dt);
    this.walkCooldown = Math.max(0, this.walkCooldown - dt);

    // 1) Update bare-hand joint visuals & pinch state
    for (const slot of this.slots) {
      this.updateHandJointsAndPinch(slot);
    }

    // 2) Handle movable 3D Control Panel drag (works with bare-hand pinch OR controller trigger/grip!)
    for (const slot of this.slots) {
      if (slot.isDraggingPanel) {
        this.buildRayFromSpace(slot.raySpace, this.raycaster);
        this.tmpTarget
          .copy(this.raycaster.ray.origin)
          .addScaledVector(this.raycaster.ray.direction, slot.panelGrabDistance);
        this.callbacks.onPanelDragMove(this.tmpTarget);
        return; // Dedicated panel movement without spinning planet underneath
      }
    }

    // 3) Unified Hand + Controller Gesture Engine:
    //    - Both hands pinching / squeezing -> Spread / Pinch-out Zoom!
    //    - One hand pinching / squeezing + moving -> Rotate Planet or Rotate 360° Street View!
    const s0 = this.slots[0];
    const s1 = this.slots[1];
    const active0 = (s0.selectActive && !s0.isClickingPanel) || s0.squeezing;
    const active1 = (s1.selectActive && !s1.isClickingPanel) || s1.squeezing;

    if (active0 && active1) {
      // Two-hand Spread / Pinch-out Zoom!
      s0.isDraggingView = true;
      s1.isDraggingView = true;
      this.getInteractionPoint(s0, this.tmpPosA);
      this.getInteractionPoint(s1, this.tmpPosB);
      const dist = this.tmpPosA.distanceTo(this.tmpPosB);
      if (this.prevTwoHandDist !== null && this.prevTwoHandDist > 0.04 && dist > 0.04) {
        const ratio = this.prevTwoHandDist / dist;
        if (Math.abs(ratio - 1) > 0.0015 && !isStreetView) {
          this.callbacks.onTwoHandZoom(Math.pow(ratio, 1.35));
        }
      }
      this.prevTwoHandDist = dist;
      s0.lastDragPos.copy(this.tmpPosA);
      s1.lastDragPos.copy(this.tmpPosB);
    } else {
      this.prevTwoHandDist = null;
      const activeSlot = active0 ? s0 : active1 ? s1 : null;
      if (activeSlot) {
        this.getInteractionPoint(activeSlot, this.tmpPosA);
        const totalMove = this.tmpPosA.distanceTo(activeSlot.dragStartPos);
        if (!activeSlot.isDraggingView && (activeSlot.squeezing || totalMove > DRAG_THRESHOLD_M)) {
          activeSlot.isDraggingView = true;
          activeSlot.lastDragPos.copy(this.tmpPosA);
        }
        if (activeSlot.isDraggingView) {
          this.tmpDelta.subVectors(this.tmpPosA, activeSlot.lastDragPos);
          if (this.tmpDelta.lengthSq() > 0.0000008) {
            this.callbacks.onRotateViewDrag(this.tmpDelta);
          }
          activeSlot.lastDragPos.copy(this.tmpPosA);
        }
      }
    }

    // 4) Optional Touch Plus Controller thumbsticks & A/B/X/Y buttons (when controllers are used)
    let buttonADown = false;
    let buttonBDown = false;
    let buttonXDown = false;

    for (const source of session.inputSources) {
      if (source.hand) continue;
      const gp = source.gamepad;
      if (!gp) continue;

      const axes = gp.axes;
      const sx = axes.length >= 4 ? axes[2] : axes[0] ?? 0;
      const sy = axes.length >= 4 ? axes[3] : axes[1] ?? 0;
      const deadzone = 0.16;
      const ax = Math.abs(sx) > deadzone ? sx : 0;
      const ay = Math.abs(sy) > deadzone ? sy : 0;

      if (source.handedness === 'left') {
        if (ax !== 0 || ay !== 0) this.callbacks.onLeftStick(ax, ay, dt);
        if (isStreetView && sy < -0.68 && this.walkCooldown <= 0) {
          this.walkCooldown = 0.7;
          this.callbacks.onWalkForward();
        }
        if (gp.buttons[4]?.pressed) buttonXDown = true;
        if (gp.buttons[5]?.pressed) buttonBDown = true;
      } else if (source.handedness === 'right') {
        if (ax !== 0 || ay !== 0) this.callbacks.onRightStick(ax, ay, dt);
        if (isStreetView && Math.abs(sx) > 0.68 && this.snapCooldown <= 0) {
          this.snapCooldown = 0.34;
          this.callbacks.onSnapTurn(sx > 0 ? 1 : -1);
        }
        if (gp.buttons[4]?.pressed) buttonADown = true;
        if (gp.buttons[5]?.pressed) buttonBDown = true;
      }
    }

    if (buttonADown && !this.prevButtonA) this.callbacks.onButtonA();
    if (buttonBDown && !this.prevButtonB) this.callbacks.onButtonB();
    if (buttonXDown && !this.prevButtonX) this.callbacks.onButtonX();
    this.prevButtonA = buttonADown;
    this.prevButtonB = buttonBDown;
    this.prevButtonX = buttonXDown;
  }
}
