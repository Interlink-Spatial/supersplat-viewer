const assertObject = (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value;
};
const assertNumber = (value, path) => {
    if (typeof value !== 'number' || !isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
    }
    return value;
};
const assertString = (value, path) => {
    if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
    }
    return value;
};
const assertBoolean = (value, path) => {
    if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
    }
    return value;
};
const assertEnum = (value, allowed, path) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
    }
    return value;
};
const assertArray = (value, path) => {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
    }
    return value;
};
const assertNumberArray = (value, path) => {
    const arr = assertArray(value, path);
    for (let i = 0; i < arr.length; i++) {
        assertNumber(arr[i], `${path}[${i}]`);
    }
    return arr;
};
const assertTuple3 = (value, path) => {
    const arr = assertNumberArray(value, path);
    if (arr.length !== 3) {
        throw new Error(`${path} must have exactly 3 elements`);
    }
    return arr;
};

const validateAnimTrack$1 = (data, path) => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    if (obj.frameRate !== undefined)
        assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.target, ['camera'], `${path}.target`);
    assertEnum(obj.loopMode, ['none', 'repeat', 'pingpong'], `${path}.loopMode`);
    assertEnum(obj.interpolation, ['step', 'spline'], `${path}.interpolation`);
    if (obj.smoothness !== undefined)
        assertNumber(obj.smoothness, `${path}.smoothness`);
    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);
    return data;
};
const validateV1 = (data) => {
    const obj = assertObject(data, 'settings');
    const camera = assertObject(obj.camera, 'settings.camera');
    if (camera.fov !== undefined)
        assertNumber(camera.fov, 'settings.camera.fov');
    if (camera.position !== undefined)
        assertNumberArray(camera.position, 'settings.camera.position');
    if (camera.target !== undefined)
        assertNumberArray(camera.target, 'settings.camera.target');
    if (camera.startAnim !== undefined)
        assertEnum(camera.startAnim, ['none', 'orbit', 'animTrack'], 'settings.camera.startAnim');
    if (camera.animTrack != null)
        assertString(camera.animTrack, 'settings.camera.animTrack');
    const bg = assertObject(obj.background, 'settings.background');
    if (bg.color !== undefined)
        assertNumberArray(bg.color, 'settings.background.color');
    if (obj.animTracks !== undefined) {
        const tracks = assertArray(obj.animTracks, 'settings.animTracks');
        tracks.forEach((t, i) => validateAnimTrack$1(t, `settings.animTracks[${i}]`));
    }
    return data;
};

const TONEMAPPING = ['none', 'linear', 'filmic', 'hejl', 'aces', 'aces2', 'neutral'];
const LOOP_MODES = ['none', 'repeat', 'pingpong'];
const INTERPOLATIONS = ['step', 'spline'];
const START_MODES = ['default', 'animTrack', 'annotation'];
const validateAnimTrack = (data, path) => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.loopMode, LOOP_MODES, `${path}.loopMode`);
    assertEnum(obj.interpolation, INTERPOLATIONS, `${path}.interpolation`);
    assertNumber(obj.smoothness, `${path}.smoothness`);
    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);
    assertNumberArray(vals.fov, `${path}.keyframes.values.fov`);
    return data;
};
const validateCamera = (data, path) => {
    const obj = assertObject(data, path);
    const initial = assertObject(obj.initial, `${path}.initial`);
    assertTuple3(initial.position, `${path}.initial.position`);
    assertTuple3(initial.target, `${path}.initial.target`);
    assertNumber(initial.fov, `${path}.initial.fov`);
    return data;
};
const validateAnnotation = (data, path) => {
    const obj = assertObject(data, path);
    assertTuple3(obj.position, `${path}.position`);
    assertString(obj.title, `${path}.title`);
    assertString(obj.text, `${path}.text`);
    validateCamera(obj.camera, `${path}.camera`);
    return data;
};
const validatePostEffects = (data, path) => {
    const obj = assertObject(data, path);
    const sh = assertObject(obj.sharpness, `${path}.sharpness`);
    assertBoolean(sh.enabled, `${path}.sharpness.enabled`);
    assertNumber(sh.amount, `${path}.sharpness.amount`);
    const bl = assertObject(obj.bloom, `${path}.bloom`);
    assertBoolean(bl.enabled, `${path}.bloom.enabled`);
    assertNumber(bl.intensity, `${path}.bloom.intensity`);
    assertNumber(bl.blurLevel, `${path}.bloom.blurLevel`);
    const gr = assertObject(obj.grading, `${path}.grading`);
    assertBoolean(gr.enabled, `${path}.grading.enabled`);
    assertNumber(gr.brightness, `${path}.grading.brightness`);
    assertNumber(gr.contrast, `${path}.grading.contrast`);
    assertNumber(gr.saturation, `${path}.grading.saturation`);
    assertTuple3(gr.tint, `${path}.grading.tint`);
    const vi = assertObject(obj.vignette, `${path}.vignette`);
    assertBoolean(vi.enabled, `${path}.vignette.enabled`);
    assertNumber(vi.intensity, `${path}.vignette.intensity`);
    assertNumber(vi.inner, `${path}.vignette.inner`);
    assertNumber(vi.outer, `${path}.vignette.outer`);
    assertNumber(vi.curvature, `${path}.vignette.curvature`);
    const fr = assertObject(obj.fringing, `${path}.fringing`);
    assertBoolean(fr.enabled, `${path}.fringing.enabled`);
    assertNumber(fr.intensity, `${path}.fringing.intensity`);
    return data;
};
const validateV2 = (data) => {
    const obj = assertObject(data, 'settings');
    if (obj.version !== 2) {
        throw new Error('settings.version must be 2');
    }
    assertEnum(obj.tonemapping, TONEMAPPING, 'settings.tonemapping');
    assertBoolean(obj.highPrecisionRendering, 'settings.highPrecisionRendering');
    if (obj.soundUrl !== undefined)
        assertString(obj.soundUrl, 'settings.soundUrl');
    const bg = assertObject(obj.background, 'settings.background');
    assertTuple3(bg.color, 'settings.background.color');
    if (bg.skyboxUrl !== undefined)
        assertString(bg.skyboxUrl, 'settings.background.skyboxUrl');
    validatePostEffects(obj.postEffectSettings, 'settings.postEffectSettings');
    const tracks = assertArray(obj.animTracks, 'settings.animTracks');
    tracks.forEach((t, i) => validateAnimTrack(t, `settings.animTracks[${i}]`));
    const cameras = assertArray(obj.cameras, 'settings.cameras');
    cameras.forEach((c, i) => validateCamera(c, `settings.cameras[${i}]`));
    const annotations = assertArray(obj.annotations, 'settings.annotations');
    annotations.forEach((a, i) => validateAnnotation(a, `settings.annotations[${i}]`));
    assertEnum(obj.startMode, START_MODES, 'settings.startMode');
    return data;
};

const migrateV1 = (settings) => {
    if (settings.animTracks) {
        settings.animTracks?.forEach((track) => {
            // some early settings did not have frameRate set on anim tracks
            if (!track.frameRate) {
                const defaultFrameRate = 30;
                track.frameRate = defaultFrameRate;
                const times = track.keyframes.times;
                for (let i = 0; i < times.length; i++) {
                    times[i] *= defaultFrameRate;
                }
            }
            // smoothness property added in v1.4.0
            if (!track.hasOwnProperty('smoothness')) {
                track.smoothness = 0;
            }
        });
    }
    else {
        // some scenes were published without animTracks
        settings.animTracks = [];
    }
    return settings;
};
const migrateAnimTrackV2 = (animTrackV1, fov) => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
            }
        }
    };
};
const migrateV2 = (v1) => {
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color || [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 1,
                blurLevel: 2
            },
            grading: {
                enabled: false,
                brightness: 0,
                contrast: 1,
                saturation: 1,
                tint: [1, 1, 1]
            },
            vignette: {
                enabled: false,
                intensity: 0.5,
                inner: 0.3,
                outer: 0.75,
                curvature: 1
            },
            fringing: {
                enabled: false,
                intensity: 0.5
            }
        },
        animTracks: v1.animTracks.map((animTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: (v1.camera.position && v1.camera.target) ? [{
                initial: {
                    position: v1.camera.position,
                    target: v1.camera.target,
                    fov: v1.camera.fov || 75
                }
            }] : [],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default'
    };
};
// migrate a JSON object to the latest settings schema (assumes valid input)
const importSettings = (settings) => {
    let result;
    const version = settings.version;
    if (version === undefined) {
        // v1 -> v2
        result = migrateV2(migrateV1(settings));
    }
    else if (version === 2) {
        // already v2
        result = settings;
    }
    else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
    return result;
};
// validate unknown data against any supported settings schema version, throwing on invalid input
const validateSettings = (settings) => {
    const obj = assertObject(settings, 'settings');
    const version = obj.version;
    if (version === undefined) {
        validateV1(settings);
    }
    else if (version === 2) {
        validateV2(settings);
    }
    else if (typeof version !== 'number') {
        throw new Error(`settings.version must be a number, got ${typeof version}`);
    }
    else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
};

export { importSettings, validateSettings };
//# sourceMappingURL=settings.js.map
