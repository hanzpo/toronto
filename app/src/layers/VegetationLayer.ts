import type { Engine } from '../engine/Engine';
import type { FrameContext, Layer } from '../engine/types';
import type { NetLayer } from '../net/NetLayer';
import { Vegetation } from './vegetation/Vegetation';

export class VegetationLayer implements Layer {
  readonly id = 'vegetation';
  private veg!: Vegetation;
  private net: NetLayer;
  constructor(net: NetLayer) { this.net = net; }

  init(engine: Engine) {
    this.veg = new Vegetation(engine);
    this.net.vegetation = this.veg;
    void this.veg.prewarm();
  }

  update(ctx: FrameContext) {
    this.veg.update(ctx);
  }

  dispose() {
    this.net.vegetation = null;
    this.veg.dispose();
  }
}
