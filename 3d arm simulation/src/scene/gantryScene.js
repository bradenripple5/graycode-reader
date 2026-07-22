import * as THREE from "three";

export const FACILITY_BELT_Z = 0.48;
export const INCH_TO_M = 0.0254;
export const BOX_DIMS = new THREE.Vector3(0.16, 0.16, 0.14);
export const FACILITY_BELT_WIDTH = 24 * INCH_TO_M;
export const GANTRY_DIMS = {
  minSpanX: 2.2,
  minSpanY: 1.3,
  uprightSize: 0.16,
  topRailThickness: 0.16,
  bridgeBeamThickness: 0.13,
  bridgeRunnerWidth: 0.42,
  braceThickness: 0.06,
  topZ: 1.08,
  bridgeZ: 1.02,
  carriageSize: new THREE.Vector3(0.21, 0.18, 0.1),
};
export const GANTRY_ARM_CONFIG = {
  count: 8,
  runnerUtilization: 0.98,
  // Keep arms visually hanging below the runner beam in both WebGL and fallback.
  idleDrop: 0.34,
  stroke: 0.34,
  speed: 0.62,
};
export const BELT_TRUNK_TOP_Y = 17.0;
export const BELT_CROSS_HALF_SPAN = 6.4;
export const SOURCE_OFFLOAD_Y = 4.25;
export const DESTINATION_SET_SPACING_Y = 10.5;
export const LOWER_CROSS_BELT_Y = SOURCE_OFFLOAD_Y - DESTINATION_SET_SPACING_Y;
export const BELT_TRUNK_BOTTOM_Y = LOWER_CROSS_BELT_Y - 1.05;
export const DESTINATION_CENTERS = [
  [-3.2, SOURCE_OFFLOAD_Y],
  [3.2, SOURCE_OFFLOAD_Y],
  [-3.2, LOWER_CROSS_BELT_Y],
  [3.2, LOWER_CROSS_BELT_Y],
];
export const DESTINATION_PALLET_DIMS = new THREE.Vector3(
  48 * INCH_TO_M,
  40 * INCH_TO_M,
  5.5 * INCH_TO_M
);
export const DESTINATION_PALLETS_ALONG_BELT = 4;
export const DESTINATION_PALLETS_PER_SIDE = 3;
export const DESTINATION_PALLET_GAP_ALONG = 6 * INCH_TO_M;
export const DESTINATION_PALLET_GAP_ACROSS = 6 * INCH_TO_M;
export const DESTINATION_PALLET_BELT_CLEARANCE = 18 * INCH_TO_M;
export const SOURCE_PALLETS_ALONG_BELT = 2;
export const SOURCE_PALLETS_PER_SIDE = 6;
export const SOURCE_GANTRY_CENTER = new THREE.Vector2(0.0, 14.9);
export const SOURCE_STACK_CENTER = new THREE.Vector2(0.0, 13.6);
export const SOURCE_PALLET_DIMS = new THREE.Vector3(48 * INCH_TO_M, 40 * INCH_TO_M, 5.5 * INCH_TO_M);
export const SOURCE_BOX_OFFSETS = [];

export function getDestinationPalletSlots(centerX, centerY) {
  const slots = [];
  const alongPitch = DESTINATION_PALLET_DIMS.x + DESTINATION_PALLET_GAP_ALONG;
  const acrossPitch = DESTINATION_PALLET_DIMS.y + DESTINATION_PALLET_GAP_ACROSS;
  const startX = centerX - ((DESTINATION_PALLETS_ALONG_BELT - 1) * alongPitch) * 0.5;
  const firstSideOffset =
    FACILITY_BELT_WIDTH * 0.5 + DESTINATION_PALLET_BELT_CLEARANCE + DESTINATION_PALLET_DIMS.y * 0.5;

  for (let side = -1; side <= 1; side += 2) {
    for (let row = 0; row < DESTINATION_PALLETS_PER_SIDE; row += 1) {
      const y = centerY + side * (firstSideOffset + row * acrossPitch);
      for (let col = 0; col < DESTINATION_PALLETS_ALONG_BELT; col += 1) {
        const x = startX + col * alongPitch;
        slots.push([x, y]);
      }
    }
  }
  return slots;
}

export function getSourcePalletSlots(centerX, centerY) {
  const slots = [];
  const alongPitch = SOURCE_PALLET_DIMS.y + DESTINATION_PALLET_GAP_ACROSS;
  const sidePitch = SOURCE_PALLET_DIMS.x + DESTINATION_PALLET_GAP_ALONG;
  const startY = centerY - ((SOURCE_PALLETS_PER_SIDE - 1) * alongPitch) * 0.5;
  const firstSideOffset =
    FACILITY_BELT_WIDTH * 0.5 + DESTINATION_PALLET_BELT_CLEARANCE + SOURCE_PALLET_DIMS.x * 0.5;

  for (let side = -1; side <= 1; side += 2) {
    for (let col = 0; col < SOURCE_PALLETS_ALONG_BELT; col += 1) {
      const x = centerX + side * (firstSideOffset + col * sidePitch);
      for (let row = 0; row < SOURCE_PALLETS_PER_SIDE; row += 1) {
        const y = startY + row * alongPitch;
        slots.push([x, y]);
      }
    }
  }
  return slots;
}

export function getSourcePickupCenter() {
  const alongPitch = SOURCE_PALLET_DIMS.y + DESTINATION_PALLET_GAP_ACROSS;
  const sidePitch = SOURCE_PALLET_DIMS.x + DESTINATION_PALLET_GAP_ALONG;
  const startY = SOURCE_STACK_CENTER.y - ((SOURCE_PALLETS_PER_SIDE - 1) * alongPitch) * 0.5;
  const firstSideOffset =
    FACILITY_BELT_WIDTH * 0.5 + DESTINATION_PALLET_BELT_CLEARANCE + SOURCE_PALLET_DIMS.x * 0.5;
  const pickupRow = Math.floor((SOURCE_PALLETS_PER_SIDE - 1) / 2);
  const pickupX = SOURCE_STACK_CENTER.x + (firstSideOffset + 0 * sidePitch);
  const pickupY = startY + pickupRow * alongPitch;
  return new THREE.Vector2(pickupX, pickupY);
}

export function getSourceBoxPositions() {
  const pickupCenter = getSourcePickupCenter();
  const boxZ = SOURCE_PALLET_DIMS.z + BOX_DIMS.z * 0.5;
  return SOURCE_BOX_OFFSETS.map(([ox, oy]) => [
    pickupCenter.x + ox,
    pickupCenter.y + oy,
    boxZ,
  ]);
}

export function computeSpanFromSlots(slots, palletDims, paddingX = 0.45, paddingY = 0.45) {
  if (!slots.length) {
    return { x: GANTRY_DIMS.minSpanX, y: GANTRY_DIMS.minSpanY };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  slots.forEach(([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });

  const spanX = maxX - minX + palletDims.x + paddingX;
  const spanY = maxY - minY + palletDims.y + paddingY;
  return {
    x: Math.max(GANTRY_DIMS.minSpanX, spanX),
    y: Math.max(GANTRY_DIMS.minSpanY, spanY),
  };
}

export function getGantryCellSpecs() {
  // Keep gantry uprights clearly outside pallet footprints so pallets do not
  // visually clip/obscure gantry corners at typical camera angles.
  const SOURCE_GANTRY_PADDING = 1.0;
  const DESTINATION_GANTRY_PADDING = 1.0;

  const sourceSpanRaw = computeSpanFromSlots(
    getSourcePalletSlots(SOURCE_STACK_CENTER.x, SOURCE_STACK_CENTER.y),
    SOURCE_PALLET_DIMS,
    SOURCE_GANTRY_PADDING,
    SOURCE_GANTRY_PADDING
  );
  // Entry/source gantry is rotated 90 deg, so swap local span axes
  // to preserve world coverage across the source pallet footprint.
  const sourceSpan = {
    x: sourceSpanRaw.y,
    y: sourceSpanRaw.x,
  };
  const destinationSpan = computeSpanFromSlots(
    getDestinationPalletSlots(DESTINATION_CENTERS[0][0], DESTINATION_CENTERS[0][1]),
    DESTINATION_PALLET_DIMS,
    DESTINATION_GANTRY_PADDING,
    DESTINATION_GANTRY_PADDING
  );

  return [
    {
      id: "gantry-source",
      x: SOURCE_GANTRY_CENTER.x,
      y: SOURCE_GANTRY_CENTER.y,
      dynamic: true,
      span: sourceSpan,
      rotationRad: Math.PI * 0.5,
    },
    ...DESTINATION_CENTERS.map(([x, y], idx) => ({
      id: `gantry-dest-${idx}`,
      x,
      y,
      dynamic: false,
      span: destinationSpan,
      rotationRad: 0,
    })),
  ];
}

export function resetGantryArmSystems(gantryArmSystems) {
  gantryArmSystems.forEach((system) => {
    system.arms.forEach((arm) => {
      arm.group.position.x = arm.homeX;
      arm.group.position.y = arm.laneY;
      arm.drop.position.z = -GANTRY_ARM_CONFIG.idleDrop;
      arm.cups.forEach((cup) => {
        cup.material.color.setHex(0x6c7f8c);
      });
    });
  });
}

export function findAttachableSourceBox(sourceBoxMeshes, padWorld) {
  let bestCandidate = null;
  let bestScore = Number.POSITIVE_INFINITY;

  sourceBoxMeshes.forEach((box) => {
    if (!box.visible) {
      return;
    }
    const boxWorld = box.getWorldPosition(new THREE.Vector3());
    const dx = Math.abs(boxWorld.x - padWorld.x);
    const dy = Math.abs(boxWorld.y - padWorld.y);
    const dz = Math.abs((boxWorld.z + BOX_DIMS.z * 0.5) - padWorld.z);
    const score = dx + dy + dz;
    if (dx < 0.12 && dy < 0.12 && dz < 0.055 && score < bestScore) {
      bestCandidate = box;
      bestScore = score;
    }
  });

  return bestCandidate;
}
