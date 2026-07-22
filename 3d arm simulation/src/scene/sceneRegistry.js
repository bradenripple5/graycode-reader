export const SCENE_IDS = {
  ARM: "arm",
  GANTRY: "gantry",
};

export function normalizeSceneId(value) {
  return value === SCENE_IDS.GANTRY ? SCENE_IDS.GANTRY : SCENE_IDS.ARM;
}

export function getSceneLabel(sceneId) {
  return sceneId === SCENE_IDS.GANTRY ? "Gantry Cell" : "Arm Workcell";
}
