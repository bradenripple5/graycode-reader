export function createObjectFactory({ THREE }) {
  return {
    createDefaultStlMesh(geometry) {
      return new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: 0xb7c7d4,
          metalness: 0.15,
          roughness: 0.55,
        })
      );
    },
  };
}
