# Texture credits

All textures are CC0 1.0 (public domain) from [ambientCG](https://ambientcg.com),
downscaled to 512×512 WebP. They tile seamlessly and are sampled in world space.

| file | source |
|---|---|
| asphalt_color.webp, asphalt_normal.webp | [Asphalt025C](https://ambientcg.com/view?id=Asphalt025C) |
| concrete_color.webp | [Concrete034](https://ambientcg.com/view?id=Concrete034) |
| grass_color.webp | [Grass004](https://ambientcg.com/view?id=Grass004) |
| pavers_color.webp | [PavingStones070](https://ambientcg.com/view?id=PavingStones070) |

Ground detail packs (luminance, normalised to mean 0.5, one material per channel;
built from the ambientCG CC0 sets below, 512×512 WebP RGBA):

| file | R | G | B | A |
|---|---|---|---|---|
| ground_detail_a.webp | [Grass004](https://ambientcg.com/view?id=Grass004) | [Asphalt025C](https://ambientcg.com/view?id=Asphalt025C) | [Concrete034](https://ambientcg.com/view?id=Concrete034) | [Gravel022](https://ambientcg.com/view?id=Gravel022) |
| ground_detail_b.webp | [Rocks011](https://ambientcg.com/view?id=Rocks011) | [Ground080](https://ambientcg.com/view?id=Ground080) (sand) | [Ground037](https://ambientcg.com/view?id=Ground037) (soil) | [Rock030](https://ambientcg.com/view?id=Rock030) |

`water_normal.webp`: generated (pipeline-free, public domain): a periodic sum of
260 random integer-wavevector ripples with a k^-1.6 spectrum biased to a
south-west wind, encoded as a tangent-space normal map (256×256, lossless).
