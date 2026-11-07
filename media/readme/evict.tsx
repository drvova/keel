import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from "raea";
import { MICHROMA, PLEX_400, PLEX_500 } from "./fonts.gen";

// Old turns leave the request whole: a print in the dark. Bone ink on obsidian, every turn printed through a 4x4
// Bayer screen in whole cells, the running turn in the one signal ink, one moving layer at a time on the glide.
const W = 1280, H = 690, FPS = 24;
const INK = "#e4e1d8", MUTED = "#9c998f", GROUND = "#101214", RAISED = "#1c1e1f", SIGNAL = "rgb(255, 150, 50)";
const CELL = 6;                       // the unit: art is sized in cells, moves in cells, lands on whole cells
const TURN = { w: 17, h: 12 };        // a turn, in cells
const GAP = 3;                        // between turns, in cells
const TURNS = 9, LEAVING = 4;
const LANE = { x: 72, w: 1136, h: 118 };
const REQ_Y = 262, SES_Y = 494;

// the glide: leaves at full speed, settles long and soft, never past its mark
function glide(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bx = (u: number) => 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u * u * (1 - u) + u ** 3;
  const by = (u: number) => 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bx(mid) < t) lo = mid; else hi = mid; }
  return by((lo + hi) / 2);
}
const span = (f: number, a: number, b: number) => glide((f - a) / (b - a));

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function Plate({ x, y, density, ink, w = TURN.w, h = TURN.h }: { x: number; y: number; density: number; ink: string; w?: number; h?: number }) {
  const cells = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    // a thinner rim: the plate reads by its silhouette before its texture
    const rim = r === 0 || c === 0 || r === h - 1 || c === w - 1 ? 0.55 : 1;
    if (density * rim * 16 > BAYER[(r % 4) * 4 + (c % 4)] + 0.5)
      cells.push(<div key={r * w + c} style={{ position: "absolute", left: c * CELL, top: r * CELL, width: CELL - 1, height: CELL - 1, background: ink }} />);
  }
  return <div style={{ position: "absolute", left: x, top: y, width: w * CELL, height: h * CELL }}>{cells}</div>;
}

const turnX = (slot: number) => LANE.x + 24 + slot * (TURN.w + GAP) * CELL;
const snap = (v: number) => Math.round(v / CELL) * CELL;
const SHIFT = LEAVING * (TURN.w + GAP) * CELL - 396;   // how far the kept turns close up: room for the pointer line

function Scene() {
  const f = useCurrentFrame();
  // 0-84: turns arrive; 96-132: the oldest four print out; 132-168: they print into the session; 168-200: the
  // rest close up and the pointer prints; 216-252: one comes back by recall; to 300: hold.
  const arrived = Math.min(TURNS, Math.floor(f / 9) + 1);
  const out = span(f, 96, 132), into = span(f, 132, 168), close = span(f, 168, 200), back = span(f, 222, 262);
  const lede =
    f < 96 ? ["Every turn stays in the request ", "while the context fills."] :
    f < 216 ? ["Past 85% of where the host compacts, ", "the oldest turns leave whole."] :
              ["The session file keeps every word: ", "recall reads it back."];

  const plates = [];
  for (let i = 0; i < arrived; i++) {
    const old = i < LEAVING, running = i === TURNS - 1;
    const enter = Math.min(1, (f - i * 9) / 8);
    if (old) {
      plates.push(<Plate key={`r${i}`} x={turnX(i)} y={REQ_Y + 23} density={enter * (1 - out)} ink={INK} />);
      plates.push(<Plate key={`s${i}`} x={turnX(i)} y={SES_Y + 23} density={0.5 * into} ink={MUTED} />);
    } else {
      plates.push(<Plate key={`r${i}`} x={turnX(i) - close * SHIFT} y={REQ_Y + 23} density={enter} ink={running ? SIGNAL : INK} />);
    }
  }
  // recall prints a copy after the running turn; the session keeps its own
  if (back > 0) plates.push(<Plate key="copy" x={turnX(TURNS) - SHIFT} y={REQ_Y + 23} density={back} ink={INK} />);

  const trigger = LANE.x + LANE.w * 0.85;
  const label = (text: string, x: number, y: number, color = MUTED, opacity = 1) =>
    <div style={{ position: "absolute", left: x, top: y, color, opacity, fontFamily: "Plex", fontSize: 24 }}>{text}</div>;

  return (
    <AbsoluteFill style={{ background: GROUND }}>
      <style>{`
        @font-face { font-family: "Michroma"; src: url("${MICHROMA}"); font-weight: 400; }
        @font-face { font-family: "Plex"; src: url("${PLEX_400}"); font-weight: 400; }
        @font-face { font-family: "Plex"; src: url("${PLEX_500}"); font-weight: 500; }
      `}</style>
      <div style={{ position: "absolute", left: LANE.x, top: 56, color: INK, fontFamily: "Michroma", fontSize: 52 }}>Old turns leave whole</div>
      <div style={{ position: "absolute", left: LANE.x, top: 146, fontFamily: "Plex", fontSize: 28 }}>
        <span style={{ color: MUTED }}>{lede[0]}</span><span style={{ color: INK }}>{lede[1]}</span>
      </div>

      <div style={{ position: "absolute", left: LANE.x, top: REQ_Y, width: LANE.w, height: LANE.h, background: RAISED, borderRadius: 10 }} />
      <div style={{ position: "absolute", left: LANE.x, top: SES_Y, width: LANE.w, height: LANE.h, background: RAISED, borderRadius: 10 }} />
      {label("the request", LANE.x, REQ_Y + LANE.h + 10)}
      {label("the session file", LANE.x, SES_Y + LANE.h + 10)}

      {/* where the host compacts: a column of cells, not a rule */}
      {[5, 11, 101, 107].map((dy) => (
        <div key={`t${dy}`} style={{ position: "absolute", left: snap(trigger), top: REQ_Y + dy, width: CELL - 1, height: CELL - 1, background: MUTED }} />
      ))}
      {label("85% of the trigger", snap(trigger) - 125, REQ_Y - 38)}

      {/* the line left where the turns were */}
      {label("#0 to #15 out of context", LANE.x + 24, REQ_Y + 26, INK, close)}
      {label("keel_recall expand:[0]", LANE.x + 24, REQ_Y + 62, MUTED, close)}

      {plates}
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="evict" width={W} height={H} fps={FPS} durationInFrames={348} component={Scene} />);
