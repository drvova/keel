# The README's animation

`evict.gif` is rendered from `evict.tsx` with [raea](https://raea.io), which draws React compositions on the GPU:

```bash
bun run fonts.ts
raea render evict.tsx -o evict.mp4 --quality high
ffmpeg -i evict.mp4 -vf "fps=24,scale=1024:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" evict.gif
```

`raea render evict.tsx --at 90,200,340 -o stills/` renders single frames to check a layout.

The faces are Michroma and IBM Plex Mono, under the SIL Open Font License (`fonts/OFL-*.txt`).
