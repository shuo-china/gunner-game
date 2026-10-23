import type { StageDefinition } from '../core';
import { ArtLibrary } from './ArtLibrary';
import { OriginalMapView, OriginalMapDefinition } from './OriginalMapView';
import { loadResourceBatch } from './ResourceBatch';
import type { GameResourcePreloader } from './GameResourcePreloader';

/** Readiness is checked before resetting the live world, so loading consumes no combat time. */
export class BattleAssetLoader {
  constructor(private readonly art: ArtLibrary, private readonly map: OriginalMapDefinition) {}

  ready(stage: StageDefinition): boolean {
    const paths = this.paths(stage);
    return !!paths && paths.every(path => this.art.frames.has(path));
  }

  /** Current encounter art may be shared with a closed panel after deduplication. */
  residentPaths(stage: StageDefinition): readonly string[] { return this.paths(stage) ?? []; }

  async load(stage: StageDefinition): Promise<void> {
    const mode = stage.ores ? 'mine' : stage.hunt ? 'hunt' : stage.boss ? 'boss' : stage.raidBoss ? 'raid' : undefined;
    if (mode && !this.art.catalog[mode]) this.art.catalog[mode] = await this.art.json(`art/${mode}-system/visuals`);
    await loadResourceBatch(this.paths(stage)!.map(path => () => this.art.loadFrame(path)));
  }

  /** Speculative main-map work is dispatched by the same frame permission and
   * single decode slot as panel preparation. Loading through ArtLibrary makes
   * a completed warmup immediately visible to ready() and foreground entry. */
  preload(stage: StageDefinition, preloader: Pick<GameResourcePreloader, 'prepareBattle'>): void {
    const paths = this.paths(stage);
    if (!paths) return; // Unseen encounter catalogs remain an explicit entry load.
    preloader.prepareBattle(paths.filter(path => !this.art.frames.has(path)),
      path => this.art.loadFrame(path, 'background'));
  }

  private paths(stage: StageDefinition): string[] | undefined {
    const paths = new Set<string>();
    const collect = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string' && value.sizeUnits) paths.add(value.path);
      Object.values(value).forEach(collect);
    };
    // Base geometry remains alive beneath mode overlays; retain the current map too.
    collect(OriginalMapView.stageFrames(this.art, this.map, stage.skinIndex));
    if (stage.ores) {
      const config = this.art.catalog.mine; if (!config) return;
      collect(config);
    }
    if (stage.raidBoss) {
      const config = this.art.catalog.raid;
      if (!config) return;
      collect([config.ground, config.portalParticles, config.bossDeathParticles,
        config.skins[stage.raidBoss.bossIndex % config.skins.length]]);
    }
    if (stage.boss) {
      const config = this.art.catalog.boss;
      if (!config) return;
      collect([config.ground, config.shadow, config.skins[stage.boss.stageIndex % config.skins.length]]);
    }
    if (stage.hunt) {
      const config = this.art.catalog.hunt; if (!config) return;
      // All twenty slimes are required for seamless continuing waves.
      collect(config);
    }
    return Array.from(paths);
  }
}
