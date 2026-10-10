/** Values cross-checked against the original scene, not just C# constructor defaults. */
export const SIMULATION_CONFIG = {
  // Repeatable test/trace delivery rate; Cat.Update is called once per render frame.
  referenceFrameStep: 1 / 60,
  // TimeManager8: rational fixed timestep 2822399 / 141120000 (~50 Hz).
  physicsStep: 2822399 / 141120000,
  maxFrameTime: 0.3333333432674408,
} as const;

export const CHARACTER_CONFIG = {
  playerSpeed: 13,
  playerRadius: 1.5,
  attackRange: 40,
  rayCount: 36,
  attackSearchInterval: 0.1,
  autoSearchInterval: 0.3,
  stopDistance: 10,
  minimumEnemyDistance: 5,
  decelerationRange: 2,
  minimumApproachSpeed: 0.2,
  velocitySmoothing: 8,
  // Cat.AutoSmoothStop: square magnitude below 0.01 is snapped to zero.
  autoStopSquaredSpeed: 0.009999999776482582,
  approachDestinationTolerance: 0.30000001192092896,
  retreatDestinationTolerance: 0.05000000074505806,
  retreatDirectionSquaredThreshold: 0.0010000000474974513,
  autoNearbyRadius: 8,
  autoZWeight: 0.4,
  autoZOffset: -15,
  autoZOffsetMinDistance: 3,
  autoZOffsetFullDistance: 10,
  maximumApproachOffsetRatio: 0.9,
} as const;

export const WEAPON_CONFIG = {
  damage: 100,
  attackInterval: 0.6,
  bulletSpeed: 70,
  bulletRadius: 0.6,
  bulletHeight: 2,
  bulletLifetime: 0.7,
  bulletMaxDistance: 50,
  bulletTrailLifetime: 1,
  muzzleDistance: 1.8,
  // Polling_manager level0:123269, Polling_List[0].Objects.
  bulletPoolSize: 27,
  spreadMinimum: 2,
  spreadMaximum: 20,
  spreadGrowth: 0.3,
  spreadDecayMultiplier: 3,
  spreadSampleThreshold: 0.01,
} as const;

export const CAMERA_CONFIG = {
  cameraHalfHeight: 40,
  defaultAspect: 9 / 16,
  cameraOffsetX: 0.07070615,
  cameraOffsetY: -1.09325769,
  cameraPosition: { x: 73.5, y: 72.11000061035156, z: -73.4000015258789 },
  rayHeight: 2,
  viewportMargin: 0.02,
} as const;

export const ENEMY_CONFIG = {
  healthByDegree: [250, 450],
  degreeZeroProbability: 0.8,
  treeHalfExtent: 3,
  treeColliderOffsetX: -2,
  treeColliderOffsetZ: 2,
} as const;

export const MAP_CONFIG = {
  treeCount: 30,
  treeGridColumns: 10,
  treeGridRows: 10,
  treeOriginX: -22.5,
  treeOriginZ: 27.5,
  treeSpacing: 5,
  treeJitter: 1.5,
  // Original Map_Grid Collider inner faces. CombatWorld applies playerRadius once.
  // Left: -43.62440109 + 32.24850082/2; right: 45.26990128 - 35.54000092/2.
  mapMinX: -27.50015068,
  mapMaxX: 27.49990082,
  // South collider center -30, depth5. Tree_Batch moves first-wave end to z110, depth5.
  mapMinZ: -27.5,
  mapMaxZ: 107.5,
  // Source Default-layer walls contain bullet Y=2. The north wall moves to
  // local (0,0,110); the twelve overlapping side tiles span z[-115,745].
  bulletWalls: [
    { minX: -35, maxX: 35, minZ: -32.5, maxZ: -27.5 },
    { minX: -35, maxX: 35, minZ: 107.5, maxZ: 112.5 },
    { minX: -59.7486515045166, maxX: -27.500150680541992, minZ: -115, maxZ: 745 },
    { minX: 27.499900817871094, maxX: 63.03990173339844, minZ: -115, maxZ: 745 },
  ],
} as const;

/** Compatibility view for the simulation; edit each responsibility's source above. */
export const COMBAT_CONFIG = {
  ...SIMULATION_CONFIG,
  ...CHARACTER_CONFIG,
  ...WEAPON_CONFIG,
  ...CAMERA_CONFIG,
  ...ENEMY_CONFIG,
  ...MAP_CONFIG,
} as const;
