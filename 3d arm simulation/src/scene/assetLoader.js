import { createObjectFactory } from "./objectFactory.js";

export function createAssetLoader({ THREE, GLTFLoader, OBJLoader, STLLoader }) {
  const objectFactory = createObjectFactory({ THREE });

  return {
    async loadFromFile(file) {
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!["glb", "gltf", "obj", "stl"].includes(ext)) {
        throw new Error("Unsupported format. Use .glb, .gltf, .obj, or .stl");
      }

      if (ext === "obj") {
        const objLoader = new OBJLoader();
        const text = await file.text();
        return objLoader.parse(text);
      }

      if (ext === "stl") {
        const stlLoader = new STLLoader();
        const geometry = stlLoader.parse(await file.arrayBuffer());
        geometry.computeVertexNormals();
        return objectFactory.createDefaultStlMesh(geometry);
      }

      const gltfLoader = new GLTFLoader();
      const input = ext === "glb" ? await file.arrayBuffer() : await file.text();
      const gltf = await new Promise((resolve, reject) => {
        gltfLoader.parse(input, "", resolve, reject);
      });
      return gltf.scene || gltf.scenes?.[0];
    },
  };
}
