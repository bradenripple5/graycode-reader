import { normalizeSceneId } from "../scene/sceneRegistry.js";

export function createAppState() {
  return {
    booted: false,
    activeSceneId: normalizeSceneId("arm"),
  };
}
