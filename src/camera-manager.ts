import {
    type BoundingBox,
    math,
    Vec3
} from 'playcanvas';

import { createFigure8Track } from './animation/create-figure8-track';
import { createRotateTrack } from './animation/create-rotate-track';
import { AnimController } from './cameras/anim-controller';
import { Camera, type CameraFrame, type CameraController } from './cameras/camera';
import { FlyController } from './cameras/fly-controller';
import { FlySource } from './cameras/fly-source';
import { OrbitController } from './cameras/orbit-controller';
import type { TargetSource } from './cameras/target-navigation';
import { WalkController } from './cameras/walk-controller';
import { WalkSource } from './cameras/walk-source';
import type { Collision } from './collision';
import { damp, easeOut } from './core/math';
import { Annotation } from './settings';
import { CameraMode, Global } from './types';

const tmpCamera = new Camera();
const tmpv = new Vec3();

// Guided-tour follow: how far a guest may turn away from where the guide is
// facing. ±90° of yaw is 180° of freedom — enough to look around a room, not
// enough to face away from what the guide is pointing at.
const FOLLOW_DEFAULT_YAW_LIMIT = 90;
const FOLLOW_DEFAULT_PITCH_LIMIT = 75;
const FOLLOW_MAX_PITCH = 85;

// Rate (1/s) at which a follower closes on the guide's latest pose. Guide
// poses arrive at ~15 Hz; easing toward each one hides that cadence.
const FOLLOW_EASE_RATE = 10;

// shortest signed difference between two angles, in degrees
const angleDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

// Walk mode is only enabled when the scene's horizontal footprint is large
// enough to walk around in. Vertical extent (Y) is irrelevant — a tall but
// narrow scene isn't walkable. Both X and Z ranges must exceed this
// minimum (in metres); below it walk mode is hidden and the viewer falls
// back to fly as the default first-person mode.
const WALK_MIN_HORIZONTAL_RANGE = 5;

const isWalkAllowed = (bbox: BoundingBox, collision: Collision | null): boolean => {
    const { x, z } = bbox.halfExtents;
    return !!collision && x * 2 >= WALK_MIN_HORIZONTAL_RANGE && z * 2 >= WALK_MIN_HORIZONTAL_RANGE;
};

const createCamera = (position: Vec3, target: Vec3, fov: number) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
};

const createFrameCamera = (bbox: BoundingBox, fov: number) => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin(fov / 180 * Math.PI * 0.5);
    return createCamera(
        new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
        bbox.center,
        fov
    );
};

class CameraManager {
    update: (deltaTime: number, cameraFrame: CameraFrame) => void;

    // Re-seed the active controller from the current camera pose and
    // cancel any in-progress transition lerp. Use after externally
    // mutating `camera` and/or `state.cameraMode` to make the change
    // visible instantly.
    snap: () => void;

    // Remote camera drive (interlink bridge): instant pose set, animated
    // flight to a pose, damped follow toward a continuously-refreshed pose,
    // and cancellation. While a remote drive is active it bypasses
    // controller output; any local input interrupt cancels it so the user
    // always wins.
    setPose: (position: Vec3, target: Vec3) => void;

    flyTo: (position: Vec3, target: Vec3, durationMs?: number) => void;

    easeTo: (position: Vec3, target: Vec3) => void;

    cancelRemote: () => void;

    // Guided-tour follow (interlink bridge): the camera stands wherever the
    // guide stands, and local input only turns the head — yaw within
    // ±yawLimit of the guide's facing, pitch within ±pitchLimit. Unlike the
    // remote drives above, local input never cancels it; the guest page
    // ends it with unfollow().
    follow: (position: Vec3, target: Vec3, yawLimit?: number, pitchLimit?: number) => void;

    unfollow: () => void;

    following = false;

    // True while a damped remote follow (easeTo) is active. The bridge
    // suppresses outbound pose emission during easing so the eased copy
    // doesn't echo back to the guide; fly-to intentionally still emits.
    remoteEasing = false;

    // holds the camera state
    camera = new Camera();

    constructor(global: Global, bbox: BoundingBox, collision: Collision | null = null) {
        const { events, settings, state } = global;

        const walkAllowed = isWalkAllowed(bbox, collision);

        const camera0 = settings.cameras[0]?.initial;
        const defaultFov = camera0?.fov ?? 75;
        const frameCamera = createFrameCamera(bbox, defaultFov);
        const resetCamera = camera0 ?
            createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov) :
            frameCamera;

        const getAnimTrack = (initial: Camera, isObjectExperience: boolean) => {
            const { animTracks } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && settings.startMode === 'animTrack') {
                // use the first animTrack
                return animTracks[0];
            } else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                initial.calcFocusPoint(tmpv);
                return createRotateTrack(initial.position, tmpv, initial.fov);
            }
            // non-object experience: gentle figure-8 motion from inside the scene
            initial.calcFocusPoint(tmpv);
            return createFigure8Track(initial.position, tmpv, initial.fov);

        };

        // object experience starts outside the bounding box
        const isObjectExperience = !bbox.containsPoint(resetCamera.position);
        const animTrack = getAnimTrack(resetCamera, isObjectExperience);

        const controllers = {
            orbit: new OrbitController(),
            fly: new FlyController(),
            walk: new WalkController(),
            // noanim disables the auto-animation entirely (interlink tours are
            // guide-led; an auto figure-8 fights the sync bridge)
            anim: animTrack && !global.config.noanim ? new AnimController(animTrack) : null
        };

        controllers.orbit.fov = resetCamera.fov;
        controllers.fly.fov = resetCamera.fov;
        controllers.fly.collision = collision;
        controllers.walk.collision = collision;

        // walk-feel overrides (interlink): hover height smooths uneven
        // terrain and stair risers; capsule radius tunes gap clearance
        if (global.config.walkHoverHeight != null) {
            controllers.walk.hoverHeight = global.config.walkHoverHeight;
        }
        if (global.config.walkCapsuleRadius != null) {
            controllers.walk.capsuleRadius = global.config.walkCapsuleRadius;
        }
        if (global.config.walkStepHeight != null) {
            controllers.walk.stepHeight = global.config.walkStepHeight;
        }
        if (global.config.walkSpawn) {
            const [sx, sy, sz] = global.config.walkSpawn;
            controllers.walk.spawnPosition = new Vec3(sx, sy, sz);
        }

        const walkSource = new WalkSource();
        const flySource = new FlySource();
        const sourcesByMode: Partial<Record<CameraMode, TargetSource>> = {
            walk: walkSource,
            fly: flySource
        };
        walkSource.onComplete = flySource.onComplete = () => {
            events.fire('navigateComplete');
        };

        const getController = (cameraMode: CameraMode): CameraController => {
            return controllers[cameraMode] as CameraController;
        };

        // set the global animation flag
        state.hasAnimation = !!controllers.anim;
        state.animationDuration = controllers.anim ? controllers.anim.animState.cursor.duration : 0;

        // the automatic opening mode: orbit when the hero camera looks at the
        // scene from outside, otherwise walk where the scene is walkable
        const defaultMode: CameraMode = isObjectExperience ? 'orbit' : (walkAllowed ? 'walk' : 'fly');

        // an explicit opening mode (interlink: the embed's data-view) wins
        // over the automatic one, unless it asks for walk in a scene that
        // cannot be walked — then the automatic choice stands
        const requestedMode = global.config.initialCameraMode;
        const initialMode: CameraMode = requestedMode && (requestedMode !== 'walk' || walkAllowed) ?
            requestedMode :
            (state.hasAnimation ? 'anim' : defaultMode);

        // initialize camera mode and initial camera position
        state.cameraMode = initialMode;
        this.camera.copy(resetCamera);

        const target = new Camera(this.camera);             // the active controller updates this
        const from = new Camera(this.camera);               // stores the previous camera state during transition
        let fromMode: CameraMode = defaultMode;

        // tracks the mode to restore when exiting walk
        let preWalkMode: CameraMode = isObjectExperience ? 'orbit' : 'fly';

        // enter the initial controller
        getController(state.cameraMode).onEnter(this.camera);

        // transition state
        const transitionSpeed = 1.0;
        let transitionTimer = 1;
        let clearOrbitTargetOnTransitionEnd = false;

        // start a new camera transition from the current pose
        const startTransition = () => {
            from.copy(this.camera);
            transitionTimer = 0;
        };

        this.snap = () => {
            getController(state.cameraMode).onEnter(this.camera);
            target.copy(this.camera);
            transitionTimer = 1;
            global.app.renderNextFrame = true;
        };

        // remote drive state (interlink bridge)
        let remoteTween: { from: Camera; to: Camera; elapsed: number; duration: number } | null = null;
        let remoteGoal: Camera | null = null;

        // follow state: the guide's latest pose, the eased copy the camera
        // stands on, and the guest's look offset from the guide's facing
        // ([pitch, yaw], degrees — the order camera.angles uses)
        let followGoal: Camera | null = null;
        const followBase = new Camera();
        const lookOffset = new Vec3();
        const lookOffsetGoal = new Vec3();
        let followYawLimit = FOLLOW_DEFAULT_YAW_LIMIT;
        let followPitchLimit = FOLLOW_DEFAULT_PITCH_LIMIT;

        const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

        // Remote drives operate on an interactive mode: leave anim first
        // (the mode-change handler clears remote state, so callers switch
        // before storing theirs).
        const exitAnimForRemote = () => {
            if (state.cameraMode === 'anim') {
                state.cameraMode = defaultMode;
            }
        };

        this.setPose = (position: Vec3, targetPos: Vec3) => {
            exitAnimForRemote();
            remoteTween = null;
            remoteGoal = null;
            this.remoteEasing = false;
            this.camera.look(position, targetPos);
            this.snap();
        };

        this.flyTo = (position: Vec3, targetPos: Vec3, durationMs = 1200) => {
            exitAnimForRemote();
            remoteGoal = null;
            this.remoteEasing = false;
            const to = new Camera(this.camera);
            to.look(position, targetPos);
            remoteTween = {
                from: new Camera(this.camera),
                to,
                elapsed: 0,
                duration: Math.max(0.001, durationMs / 1000)
            };

            // A guide-led flight (a preset view) is the guide redirecting
            // attention: land facing it, and keep following from there.
            if (followGoal) {
                followGoal.copy(to);
                followBase.copy(to);
                lookOffset.set(0, 0, 0);
                lookOffsetGoal.set(0, 0, 0);
            }
        };

        this.easeTo = (position: Vec3, targetPos: Vec3) => {
            exitAnimForRemote();
            remoteTween = null;
            const goal = remoteGoal ?? new Camera(this.camera);
            goal.look(position, targetPos);
            remoteGoal = goal;
            this.remoteEasing = true;
        };

        this.cancelRemote = () => {
            if (remoteTween || remoteGoal) {
                remoteTween = null;
                remoteGoal = null;
                this.remoteEasing = false;
                this.snap();
            }
        };

        // Look-around is first-person: entering fly makes every input
        // device produce first-person look deltas, with each device's own
        // drag convention (camera-centric mouse, direct-manipulation touch).
        const isFollowMode = (mode: CameraMode) => mode === 'fly' || mode === 'walk';

        this.follow = (position: Vec3, targetPos: Vec3, yawLimit = FOLLOW_DEFAULT_YAW_LIMIT, pitchLimit = FOLLOW_DEFAULT_PITCH_LIMIT) => {
            followYawLimit = math.clamp(yawLimit, 0, 180);
            followPitchLimit = math.clamp(pitchLimit, 0, FOLLOW_MAX_PITCH);

            const goal = followGoal ?? new Camera(this.camera);
            goal.look(position, targetPos);
            goal.fov = this.camera.fov;

            if (!followGoal) {
                // first contact: stand where the guide is, facing where
                // they face, rather than gliding in from wherever we were
                exitAnimForRemote();
                if (!isFollowMode(state.cameraMode)) {
                    state.cameraMode = 'fly';
                }
                remoteTween = null;
                remoteGoal = null;
                this.remoteEasing = false;
                followBase.copy(goal);
                lookOffset.set(0, 0, 0);
                lookOffsetGoal.set(0, 0, 0);
            }

            followGoal = goal;
            this.following = true;
            global.app.renderNextFrame = true;
        };

        this.unfollow = () => {
            if (!followGoal) {
                return;
            }
            followGoal = null;
            this.following = false;
            this.snap();
        };

        // application update
        this.update = (deltaTime: number, frame: CameraFrame) => {

            // remote drive overrides controller output while active
            if (remoteTween) {
                remoteTween.elapsed += deltaTime;
                const t = Math.min(1, remoteTween.elapsed / remoteTween.duration);
                this.camera.lerp(remoteTween.from, remoteTween.to, easeInOutCubic(t));
                global.app.renderNextFrame = true;
                if (t >= 1) {
                    remoteTween = null;
                    this.snap();
                }
                return;
            }
            if (followGoal) {
                // position and facing come from the guide; only look input
                // is honoured, and only inside the allowed cone
                const { rotate } = frame.read();
                lookOffsetGoal.x = math.clamp(lookOffsetGoal.x - rotate[1], -followPitchLimit, followPitchLimit);
                lookOffsetGoal.y = math.clamp(lookOffsetGoal.y - rotate[0], -followYawLimit, followYawLimit);
                lookOffset.lerp(lookOffset, lookOffsetGoal, damp(0.95, deltaTime));

                const f = 1 - Math.exp(-deltaTime * FOLLOW_EASE_RATE);
                followBase.position.lerp(followBase.position, followGoal.position, f);
                followBase.angles.x += (followGoal.angles.x - followBase.angles.x) * f;
                followBase.angles.y += angleDelta(followBase.angles.y, followGoal.angles.y) * f;
                followBase.distance = math.lerp(followBase.distance, followGoal.distance, f);

                const pitch = math.clamp(followBase.angles.x + lookOffset.x, -FOLLOW_MAX_PITCH, FOLLOW_MAX_PITCH);
                const yaw = followBase.angles.y + lookOffset.y;
                const moved = this.camera.position.distance(followBase.position) > 1e-5 ||
                    Math.abs(this.camera.angles.x - pitch) > 1e-4 ||
                    Math.abs(this.camera.angles.y - yaw) > 1e-4;

                this.camera.position.copy(followBase.position);
                this.camera.angles.set(pitch, yaw, 0);
                this.camera.distance = followBase.distance;
                if (moved) {
                    global.app.renderNextFrame = true;
                }
                return;
            }
            if (remoteGoal) {
                const f = 1 - Math.exp(-deltaTime * 4);
                tmpCamera.copy(this.camera);
                this.camera.lerp(tmpCamera, remoteGoal, f);
                global.app.renderNextFrame = true;
                if (this.camera.position.distance(remoteGoal.position) < 0.005) {
                    remoteGoal = null;
                    this.remoteEasing = false;
                    this.snap();
                }
                return;
            }

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;

            // update transition timer
            const prevTransitionTimer = transitionTimer;
            transitionTimer = Math.min(1, transitionTimer + deltaTime * transitionSpeed);

            const controller = getController(state.cameraMode);

            sourcesByMode[state.cameraMode]?.update(dt, this.camera, frame);

            controller.update(dt, frame, target);

            if (transitionTimer < 1) {
                // lerp away from previous camera during transition
                this.camera.lerp(from, target, easeOut(transitionTimer));
            } else {
                this.camera.copy(target);
            }

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }

            if (clearOrbitTargetOnTransitionEnd && prevTransitionTimer < 1 && transitionTimer === 1) {
                clearOrbitTargetOnTransitionEnd = false;
                events.fire('orbitTarget:clear');
            }
        };

        // handle input events
        events.on('inputEvent', (eventName) => {
            // local input always wins over a remote (bridge-driven) camera
            if (eventName === 'interrupt') {
                this.cancelRemote();
            }
            // following: the only local camera action is looking around, and
            // reset brings the view back to where the guide is facing
            if (followGoal) {
                if (eventName === 'reset') {
                    lookOffsetGoal.set(0, 0, 0);
                }
                return;
            }
            switch (eventName) {
                case 'frame':
                    events.fire('orbitTarget:clear');
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(frameCamera);
                    startTransition();
                    break;
                case 'reset':
                    if (state.cameraMode === 'walk') {
                        walkSource.cancel();
                        events.fire('navTarget:clear');
                        startTransition();
                        controllers.walk.resetToSpawn(target);
                    } else if (state.cameraMode === 'fly') {
                        flySource.cancel();
                        startTransition();
                        controllers.fly.resetToSpawn(target);
                    } else {
                        events.fire('orbitTarget:clear');
                        state.cameraMode = 'orbit';
                        controllers.orbit.goto(resetCamera);
                        startTransition();
                    }
                    break;
                case 'playPause':
                    if (state.hasAnimation) {
                        if (state.cameraMode === 'anim') {
                            state.animationPaused = !state.animationPaused;
                        } else {
                            state.cameraMode = 'anim';
                            state.animationPaused = false;
                        }
                    }
                    break;
                case 'requestFirstPerson':
                    state.cameraMode = 'fly';
                    break;
                case 'toggleWalk':
                    if (walkAllowed) {
                        if (state.cameraMode === 'walk') {
                            state.cameraMode = preWalkMode;
                        } else {
                            preWalkMode = state.cameraMode;
                            state.cameraMode = 'walk';
                        }
                    }
                    break;
                case 'exitWalk':
                    if (state.cameraMode === 'walk') {
                        state.cameraMode = preWalkMode;
                    }
                    break;
                case 'cancel':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode;
                    }
                    break;
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode;
                    }
                    break;
            }
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value: CameraMode, prev: CameraMode) => {
            remoteTween = null;
            remoteGoal = null;
            this.remoteEasing = false;
            sourcesByMode[prev]?.cancel();

            // a follower stays first-person (mode shortcuts and the mode
            // buttons can still fire); put it back on the next tick, outside
            // this change notification
            if (followGoal && !isFollowMode(value)) {
                setTimeout(() => {
                    if (followGoal && !isFollowMode(state.cameraMode)) {
                        state.cameraMode = 'fly';
                    }
                });
            }

            // snapshot the current pose before any controller mutation
            startTransition();

            target.copy(this.camera);
            fromMode = prev;

            // exit the old controller
            const prevController = getController(prev);
            prevController.onExit(this.camera);

            // enter new controller
            const newController = getController(value);
            newController.onEnter(this.camera);
        });

        // handle user scrubbing the animation timeline
        events.on('scrubAnim', (time) => {
            // switch to animation camera if we're not already there
            state.cameraMode = 'anim';

            // set time
            controllers.anim.animState.cursor.value = time;
        });

        // handle user picking in the scene
        events.on('pick', (position: Vec3) => {
            if (followGoal) {
                return;
            }

            // switch to orbit camera on pick
            state.cameraMode = 'orbit';

            // construct camera
            tmpCamera.copy(this.camera);
            tmpCamera.look(this.camera.position, position);

            controllers.orbit.goto(tmpCamera);
            startTransition();
            clearOrbitTargetOnTransitionEnd = true;
        });

        events.on('annotation.activate', (annotation: Annotation) => {
            events.fire('orbitTarget:clear');

            // switch to orbit camera on pick
            state.cameraMode = 'orbit';

            const { initial } = annotation.camera;

            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(
                new Vec3(initial.position),
                new Vec3(initial.target)
            );

            controllers.orbit.goto(tmpCamera);
            startTransition();
        });

        // tap-to-navigate: start auto-driving the active mode toward a picked position
        events.on('navigateTo', (position: Vec3, normal: Vec3, speedMul = 1) => {
            if (followGoal) {
                return;
            }
            this.cancelRemote();
            const source = sourcesByMode[state.cameraMode];
            if (source) {
                source.navigateTo(position, speedMul);
                events.fire('navTarget:set', position, normal);
            }
        });

        // cancel any active auto-navigation in the current mode
        events.on('navigateCancel', () => {
            sourcesByMode[state.cameraMode]?.cancel();
            events.fire('navTarget:clear');
        });

        events.on('navigateComplete', () => {
            events.fire('navTarget:clear');
        });
    }
}

export { CameraManager, isWalkAllowed };
