import * as THREE from "three";
import GUI from "lil-gui";

// ===== 調整可能パラメータ ========================================
// すべてここに集約。GUI パネルから実時間で変更でき、Export/Import も可能。
const CONFIG = {
  // 盤面 / 難易度（変更は Restart で反映）
  grid: 7, // 盤面の一辺のマス数
  startDice: 10, // 開始時のダイス数
  // タイミング（ミリ秒・即反映）
  rollMs: 150, // 転がし / 押しのアニメ時間
  moveMs: 120, // アクイの歩き / 乗り移りのアニメ時間
  hopMs: 500, // ジャンプ(Z/Shift)の滞空時間（空中で着地先を決める余裕）
  sinkMs: 5000, // 消滅（沈む）基準時間（目=3のとき）。長いほどゆっくり消える
  sinkMsPerPip: 670, // 目1つあたりの消滅時間増分（大きい目ほど長く消える）
  sinkPlayable: 0.5, // この割合まで沈む間は足場として乗れる（地面に落ちない）
  riseMs: 1500, // せり上がり（出現）アニメ時間
  // せり上がり（即反映）
  spawnBase: 6000, // せり上がり間隔（開始）
  spawnMin: 2800, // せり上がり間隔（最短）
  spawnAccel: 0.012, // 経過での間隔短縮レート（小さいほど緩やか）
  // 動き / 演出（即反映）
  jumpHeight: 0.22, // 乗り移り時の小ジャンプの高さ
  hopHeight: 1.1, // ジャンプ(Z/Shift)のアーチの高さ
  liftHeight: 0.95, // 持ち上げたダイスの頭上オフセット
  sinkDepth: 1.15, // 消滅時に沈む深さ（CELL 倍）
  flashScale: 2.8, // 消滅フラッシュの最大拡大率
  particleCount: 7, // 消滅パーティクル数
  particleSpeed: 1.3, // パーティクルの初速
  gravity: 7, // パーティクルにかかる重力
  fallGravity: 22, // 土台が消えて落ちるサイコロの重力
  weightSink: 0.07, // 乗っているサイコロがキャラの重みで沈む量
  chainReturn: 0.1, // チェーン時に消えかけを戻す量（沈み進行 t を戻す）
  sfxVolume: 0.04, // 効果音の音量
  showLog: true, // 操作・消滅ログを画面に表示（デバッグ用）
};

// ===== 構造定数（固定） ==========================================
let GRID = CONFIG.grid; // 実際に使う盤面サイズ（Restart で CONFIG.grid を反映）
const CELL = 1; // 1マスのワールドサイズ
const HALF = CELL * 0.5; // ダイスの半径
const Y = HALF; // ダイス中心の高さ（底面が y=0 に乗る）

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// 目の数ごとの色（本家 XI 風: 1=赤 … 6=紫）
const FACE_COLORS: Record<number, { bg: string; pip: string }> = {
  1: { bg: "#e24b5c", pip: "#ffe9ec" },
  2: { bg: "#ef8a3c", pip: "#2a1c0e" },
  3: { bg: "#f2c844", pip: "#3a2e0a" },
  4: { bg: "#5bb673", pip: "#0e2c17" },
  5: { bg: "#4a98e0", pip: "#0b2238" },
  6: { bg: "#a96ce0", pip: "#fbf2ff" },
};

// ===== 型 =======================================================
type Orient = {
  top: number;
  bottom: number;
  east: number;
  west: number;
  south: number;
  north: number;
};
type Dir = {
  dx: number;
  dz: number;
  axis: THREE.Vector3;
  angle: number;
  yaw: number; // アクイがこの方向を向くときの Y 回転
  logic: (o: Orient) => Orient;
};
interface Die {
  mesh: THREE.Mesh;
  gx: number;
  gz: number;
  orient: Orient;
  sinking?: { t: number; level: number; duration: number }; // 沈み中。t<sinkPlayable は足場（触れる）。level=開始時の段。duration=この目の消滅時間
  reserved?: boolean; // 下段に乗って一緒に沈む上段（半分で重力落下に切り替わる）
  falling?: { toY: number; vy: number }; // 土台が消えて重力落下中（toY=着地 y、vy=落下速度）
}
type Anim = {
  type: "dieRoll" | "dieSlide" | "playerMove" | "jump";
  t: number;
  ms: number;
  // dieRoll / dieSlide 共通
  die?: Die;
  dir?: Dir;
  nx?: number;
  nz?: number;
  // dieRoll
  carry?: boolean;
  pivot?: THREE.Vector3;
  baseQuat?: THREE.Quaternion;
  baseRel?: THREE.Vector3;
  drop?: number; // 転がしで下る高さ（段差ぶん）
  // dieSlide
  from?: { x: number; z: number };
  fromY?: number;
  to?: { x: number; z: number };
  pFrom?: { x: number; z: number };
  pTo?: { x: number; z: number };
  pToCell?: { gx: number; gz: number };
  pH?: number; // 押し中・前進後のアクイの段（不変）
  // playerMove
  pmFrom?: THREE.Vector3;
  pmTo?: THREE.Vector3;
  toH?: number; // 着地後の段数
  arc?: number; // ジャンプのアーチ高さ
  // jump（垂直ジャンプ＋空中で着地先決定）
  baseGX?: number;
  baseGZ?: number;
  hx?: number; // 着地先セル
  hz?: number;
  baseY?: number;
  jumpDie?: Die | null; // 一緒に跳んで積むサイコロ（無ければ素ジャンプ）
  jumpBaseQuat?: THREE.Quaternion; // ジャンプ開始時のサイコロの向き
  jumpLocked?: boolean; // 着地方向を最初の入力で固定したか
};
type Effect =
  | { kind: "rise"; mesh: THREE.Object3D; t: number; ms: number }
  | { kind: "flash"; mesh: THREE.Sprite; t: number; ms: number }
  | { kind: "particle"; mesh: THREE.Sprite; vel: THREE.Vector3; t: number; ms: number };

// ===== シーン基本 ================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(GRID * 0.7, GRID * 1.05, GRID * 0.95);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(5, 10, 6);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.35);
fillLight.position.set(-6, 4, -3);
scene.add(fillLight);

// 盤面・床・視点（GRID 変更時に作り直す）
let board: THREE.Mesh | null = null;
let gridHelper: THREE.GridHelper | null = null;
let pit: THREE.Mesh | null = null;

function buildStage() {
  for (const o of [board, gridHelper, pit]) if (o) scene.remove(o);

  board = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID * CELL, GRID * CELL),
    new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.9 })
  );
  board.rotation.x = -Math.PI / 2;
  scene.add(board);

  gridHelper = new THREE.GridHelper(GRID * CELL, GRID, 0x3a4a6a, 0x2a3346);
  gridHelper.position.y = 0.01;
  scene.add(gridHelper);

  // 床下を隠すための薄い箱（せり上がり前のダイスを覆う）
  pit = new THREE.Mesh(
    new THREE.BoxGeometry(GRID * CELL, CELL * 1.2, GRID * CELL),
    new THREE.MeshStandardMaterial({ color: 0x0b0d12 })
  );
  pit.position.y = -CELL * 0.6 - 0.02;
  scene.add(pit);

  // 視点を盤面サイズに合わせる
  camera.position.set(GRID * 0.7, GRID * 1.05, GRID * 0.95);
  camera.lookAt(0, 0, 0);
}
buildStage();

// ===== ダイス目テクスチャ ========================================
function makePipTexture(value: number, bg: string, pip: string): THREE.Texture {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, s, s);
  // 軽い縁取り
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.lineWidth = s * 0.06;
  ctx.strokeRect(0, 0, s, s);
  ctx.fillStyle = pip;
  const r = s * 0.09;
  const a = s * 0.27,
    b = s * 0.5,
    d = s * 0.73;
  const layouts: Record<number, [number, number][]> = {
    1: [[b, b]],
    2: [[a, a], [d, d]],
    3: [[a, a], [b, b], [d, d]],
    4: [[a, a], [d, a], [a, d], [d, d]],
    5: [[a, a], [d, a], [b, b], [a, d], [d, d]],
    6: [[a, a], [d, a], [a, b], [d, b], [a, d], [d, d]],
  };
  for (const [x, y] of layouts[value]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// BoxGeometry のマテリアル順: [+x,-x,+y,-y,+z,-z] = [east,west,top,bottom,south,north]
const FACE_VALUES = [3, 4, 1, 6, 5, 2];
const dieMaterials = FACE_VALUES.map(
  (v) =>
    new THREE.MeshStandardMaterial({
      map: makePipTexture(v, FACE_COLORS[v].bg, FACE_COLORS[v].pip),
      roughness: 0.4,
      metalness: 0.05,
    })
);
const dieGeo = new THREE.BoxGeometry(CELL, CELL, CELL);

// 画面左上に表示する「今乗っているサイコロ」のプレビュー（カメラに固定）
scene.add(camera);
const miniPivot = new THREE.Group();
miniPivot.position.set(-3.7, 1.7, -5); // カメラ前方・左上
miniPivot.rotation.set(0.5, -0.7, 0); // 上・前・横の3面が見える角度に傾ける
miniPivot.visible = false;
camera.add(miniPivot);
const miniDie = new THREE.Mesh(dieGeo, dieMaterials);
miniDie.scale.setScalar(0.55);
miniPivot.add(miniDie); // 向きは tick で乗っているサイコロに連動

// 柔らかい光テクスチャ（フラッシュ・パーティクル用）
function makeGlowTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.75)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const glowTex = makeGlowTexture();

// ===== 転がし方向 ===============================================
const DIRS: Record<string, Dir> = {
  east:  { dx: 1,  dz: 0,  axis: new THREE.Vector3(0, 0, 1), angle: -Math.PI / 2, yaw:  Math.PI / 2, logic: (o) => ({ ...o, top: o.west, west: o.bottom, bottom: o.east, east: o.top }) },
  west:  { dx: -1, dz: 0,  axis: new THREE.Vector3(0, 0, 1), angle:  Math.PI / 2, yaw: -Math.PI / 2, logic: (o) => ({ ...o, top: o.east, east: o.bottom, bottom: o.west, west: o.top }) },
  north: { dx: 0,  dz: -1, axis: new THREE.Vector3(1, 0, 0), angle: -Math.PI / 2, yaw:  Math.PI,     logic: (o) => ({ ...o, top: o.south, south: o.bottom, bottom: o.north, north: o.top }) },
  south: { dx: 0,  dz: 1,  axis: new THREE.Vector3(1, 0, 0), angle:  Math.PI / 2, yaw:  0,           logic: (o) => ({ ...o, top: o.north, north: o.bottom, bottom: o.south, south: o.top }) },
};

// ===== 盤面状態（スタック式・最大2段）===========================
const MAX_STACK = 2;
let cells: Die[][][] = []; // cells[gx][gz] = 下→上のスタック
function rebuildCells() {
  cells = [];
  for (let x = 0; x < GRID; x++) {
    const col: Die[][] = [];
    for (let z = 0; z < GRID; z++) col.push([]);
    cells.push(col);
  }
}
rebuildCells();
const dice: Die[] = [];
const effects: Effect[] = [];
let anim: Anim | null = null; // プレイヤー起因の単一アニメ（あいだは入力ロック）
let score = 0;
let chain = 0; // 連鎖（沈みかけに繋いで連続で消した回数）
let link = 0; // リンク（1手で同時に消した独立グループ数）
let elapsed = 0;
let spawnTimer = 0;
let over = false;
let weightedDie: Die | null = null; // キャラの重みで沈めている足元のサイコロ

const inBounds = (x: number, z: number) =>
  x >= 0 && x < GRID && z >= 0 && z < GRID;

// ----- スタック ヘルパー（cells への直アクセスはここ経由）-----
const height = (gx: number, gz: number): number =>
  inBounds(gx, gz) ? cells[gx][gz].length : 0;
const topDie = (gx: number, gz: number): Die | null => {
  if (!inBounds(gx, gz)) return null;
  const s = cells[gx][gz];
  return s.length ? s[s.length - 1] : null;
};
const isFull = (gx: number, gz: number): boolean =>
  height(gx, gz) >= MAX_STACK;
const dieWorldY = (level: number): number => Y + level * CELL; // 段の中心 y
const dieLevel = (die: Die): number => cells[die.gx][die.gz].indexOf(die);

function pushDie(gx: number, gz: number, die: Die) {
  die.gx = gx;
  die.gz = gz;
  cells[gx][gz].push(die);
  const { x, z } = gridToWorld(gx, gz);
  die.mesh.position.set(x, dieWorldY(cells[gx][gz].length - 1), z);
}
function popDie(gx: number, gz: number): Die | null {
  return cells[gx][gz].pop() ?? null;
}

function gridToWorld(gx: number, gz: number) {
  return {
    x: (gx - (GRID - 1) / 2) * CELL,
    z: (gz - (GRID - 1) / 2) * CELL,
  };
}

function makeDie(gx: number, gz: number): Die {
  const mesh = new THREE.Mesh(dieGeo, dieMaterials);
  scene.add(mesh);
  const die: Die = {
    mesh,
    gx,
    gz,
    orient: { top: 1, bottom: 6, east: 3, west: 4, south: 5, north: 2 },
  };
  const keys = Object.keys(DIRS);
  const n = 1 + Math.floor(Math.random() * 6);
  for (let i = 0; i < n; i++) {
    const d = DIRS[keys[Math.floor(Math.random() * keys.length)]];
    const q = new THREE.Quaternion().setFromAxisAngle(d.axis, d.angle);
    mesh.quaternion.premultiply(q);
    die.orient = d.logic(die.orient);
  }
  pushDie(gx, gz, die); // スタックに積む（y も設定）
  dice.push(die);
  return die;
}

function spawnDie(gx: number, gz: number): Die {
  const die = makeDie(gx, gz);
  die.mesh.position.y = -CELL; // 床下から（せり上がりは空マス=1段目のみ）
  effects.push({ kind: "rise", mesh: die.mesh, t: 0, ms: CONFIG.riseMs });
  return die;
}

// ===== プレイヤー（悪魔） ========================================
function makeDevil(): THREE.Group {
  const g = new THREE.Group(); // 原点 = 足元
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 18, 18),
    new THREE.MeshStandardMaterial({ color: 0xd6402f, roughness: 0.5 })
  );
  body.position.y = 0.24;
  body.scale.y = 1.1;
  g.add(body);
  const hornMat = new THREE.MeshStandardMaterial({ color: 0x23262e });
  for (const sx of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 8), hornMat);
    horn.position.set(sx * 0.1, 0.47, 0);
    horn.rotation.z = sx * -0.25;
    g.add(horn);
  }
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d8,
    emissive: 0x332200,
  });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), eyeMat);
    eye.position.set(sx * 0.085, 0.3, 0.19);
    g.add(eye);
  }
  // 前方インジケータ（鼻／くちばし）— 向きが分かるように +z へ突き出す
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.2, 10),
    new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x3a2a00 })
  );
  nose.rotation.x = Math.PI / 2; // 先端を +z（正面）へ
  nose.position.set(0, 0.22, 0.26);
  g.add(nose);
  scene.add(g);
  return g;
}

const player = {
  gx: 0,
  gz: 0,
  h: 1, // 立っている段数（0=床, 1, 2）。足元スタックの高さから導出
  mesh: makeDevil(),
  carrying: null as Die | null, // 持ち上げ中のダイス
  facing: DIRS.east, // 最後に向いた方向（持ち上げ／設置の対象に使う）
};

// 設置先ガイド
const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(CELL * 0.96, CELL * 0.96, CELL * 0.96),
  new THREE.MeshBasicMaterial({
    color: 0x6cf0ff,
    transparent: true,
    opacity: 0.25,
    depthWrite: false,
  })
);
ghost.visible = false;
scene.add(ghost);

// 設置先マス（向いている前方で、まだ2段に達していないマス）
function placeTarget(): { gx: number; gz: number } | null {
  const f = player.facing;
  const fx = player.gx + f.dx;
  const fz = player.gz + f.dz;
  if (inBounds(fx, fz) && !isFull(fx, fz)) return { gx: fx, gz: fz };
  return null;
}

const ghostMat = ghost.material as THREE.MeshBasicMaterial;
function updateGhost() {
  if (player.carrying) {
    // 設置先（前方の積めるマス）を水色で。乗る段の高さに合わせる
    const t = placeTarget();
    if (!t) {
      ghost.visible = false;
      return;
    }
    const { x, z } = gridToWorld(t.gx, t.gz);
    ghost.position.set(x, dieWorldY(height(t.gx, t.gz)), z);
    ghostMat.color.setHex(0x6cf0ff);
    ghostMat.opacity = 0.25;
    ghost.visible = true;
  } else {
    // 持ち上げ対象（前方の最上段ダイス）を橙色でハイライト
    const f = player.facing;
    const tx = player.gx + f.dx;
    const tz = player.gz + f.dz;
    if (topDie(tx, tz)) {
      const { x, z } = gridToWorld(tx, tz);
      ghost.position.set(x, dieWorldY(height(tx, tz) - 1), z);
      ghostMat.color.setHex(0xffc14d);
      ghostMat.opacity = 0.33;
      ghost.visible = true;
    } else {
      ghost.visible = false;
    }
  }
}

function syncCarry() {
  if (!player.carrying) return;
  const p = player.mesh.position;
  player.carrying.mesh.position.set(p.x, p.y + CONFIG.liftHeight, p.z);
}

// アクイの足元ワールド座標（h 段の上 = y: h*CELL）
function playerWorld(gx: number, gz: number, h: number) {
  const { x, z } = gridToWorld(gx, gz);
  return { x, y: h * CELL, z };
}

function placeDevil() {
  const p = playerWorld(player.gx, player.gz, player.h);
  player.mesh.position.set(p.x, p.y, p.z);
}

// ===== 効果音（WebAudio・ライブラリ不要）========================
let actx: AudioContext | null = null;
function ensureAudio() {
  if (!actx) actx = new AudioContext();
  if (actx.state === "suspended") void actx.resume();
}
function sfx(
  freq: number,
  dur: number,
  type: OscillatorType = "square",
  gain = CONFIG.sfxVolume,
  slideTo?: number
) {
  if (!actx) return;
  const t0 = actx.currentTime;
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(actx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

// ===== 入力 =====================================================
const KEYMAP: Record<string, string> = {
  ArrowRight: "east",
  ArrowLeft: "west",
  ArrowUp: "north",
  ArrowDown: "south",
};

window.addEventListener("keydown", (e) => {
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    ensureAudio();
    handleLift();
    return;
  }
  if (e.key === "z" || e.key === "Z" || e.code === "KeyZ" || e.key === "Shift") {
    e.preventDefault();
    ensureAudio();
    if (e.repeat) return; // 押しっぱなしの連射を防ぐ
    tryJump(); // 持ったままでも跳べる
    return;
  }
  const dirName = KEYMAP[e.key];
  if (!dirName) return;
  e.preventDefault();
  ensureAudio();
  if (over) return;

  const dir = DIRS[dirName];

  // ジャンプ滞空中: 最初に押した方向で着地先を1回だけ決める（以降の入力は無視）
  if (anim) {
    if (anim.type === "jump" && !anim.jumpLocked) {
      const hx = anim.baseGX! + dir.dx;
      const hz = anim.baseGZ! + dir.dz;
      // 着地先は「2段未満」のマスのみ（2段スタックには乗れない・積めない）
      if (inBounds(hx, hz) && height(hx, hz) < MAX_STACK) {
        player.facing = dir;
        player.mesh.rotation.y = dir.yaw;
        anim.hx = hx;
        anim.hz = hz;
        anim.jumpLocked = true; // 最初の有効入力で固定
      }
    }
    return;
  }

  player.facing = dir;
  player.mesh.rotation.y = dir.yaw;

  const gx = player.gx;
  const gz = player.gz;
  const nx = gx + dir.dx;
  const nz = gz + dir.dz;
  if (!inBounds(nx, nz)) return;

  const h = height(gx, gz); // アクイ足元の段数
  const hn = height(nx, nz); // 進行先の段数

  if (hn === h) {
    // 同じ高さ → 床歩き / 乗り移り
    startPlayerMove(nx, nz, h);
  } else if (hn === h + 1) {
    // 正面（アクイ足元と同じ段）の最上段サイコロを押す（回転しない・目は変わらない）
    const die = topDie(nx, nz)!;
    if (die.sinking) return;
    const nx2 = nx + dir.dx;
    const nz2 = nz + dir.dz;
    if (!inBounds(nx2, nz2)) return;
    const h2 = height(nx2, nz2);
    // 床からの押しは空マスへのみ（積まない）。
    // 上段(h>=1)の押しは押し出し先が2段未満なら可：低ければ落ちる／1段ならその上に乗る。2段なら押せない
    const canPush = h === 0 ? h2 === 0 : h2 < MAX_STACK;
    if (canPush) startDieSlide(die, dir, nx2, nz2);
  } else if (hn < h) {
    // 低い隣 → 乗っている最上段を転がす（空マスなら降りる / 1段なら2段目に積む）
    const die = topDie(gx, gz)!;
    if (die.sinking) return;
    startDieRoll(die, dir, nx, nz, true);
  }
  // hn > h + 1 → 段差が大きく登れない（ジャンプで越える）
});

// ===== アニメ開始 ===============================================
function startDieRoll(die: Die, dir: Dir, nx: number, nz: number, carry: boolean) {
  const from = gridToWorld(die.gx, die.gz);
  const level = dieLevel(die); // 転がす前の段（最上段）
  const landLevel = height(nx, nz); // 転がし先で乗る段
  const axisY = level * CELL; // 回転軸＝土台の上面の高さ
  const baseY = dieWorldY(level); // 現在の中心 y
  const pivot = new THREE.Vector3(from.x + dir.dx * HALF, axisY, from.z + dir.dz * HALF);
  anim = {
    type: "dieRoll",
    die, dir, nx, nz, carry,
    pivot,
    baseQuat: die.mesh.quaternion.clone(),
    baseRel: new THREE.Vector3(from.x, baseY, from.z).sub(pivot),
    drop: (level - landLevel) * CELL, // 段差ぶん転がりながら下る
    t: 0,
    ms: CONFIG.rollMs,
  };
  popDie(die.gx, die.gz); // 最上段を抜く（土台は残る）
  sfx(180, 0.06, "square", 0.03);
  logMsg(`転がし 目${die.orient.top}→(${nx},${nz})`);
}

function startDieSlide(die: Die, _dir: Dir, nx: number, nz: number) {
  const level = dieLevel(die); // 押す前の段（= アクイ足元 h）
  anim = {
    type: "dieSlide",
    die, nx, nz,
    from: gridToWorld(die.gx, die.gz),
    fromY: dieWorldY(level),
    to: gridToWorld(nx, nz),
    pFrom: gridToWorld(player.gx, player.gz),
    pTo: gridToWorld(die.gx, die.gz), // アクイは押したサイコロが居たマスへ前進
    pToCell: { gx: die.gx, gz: die.gz },
    pH: player.h, // 押し中・前進後のアクイの段（不変）
    t: 0,
    ms: CONFIG.rollMs,
  };
  popDie(die.gx, die.gz);
  sfx(140, 0.08, "sawtooth", 0.025);
  logMsg(`押し 目${die.orient.top}→(${nx},${nz})`);
}

// アクイ単体の移動（乗り移り / 床歩き）。h = 着地後の段数
function startPlayerMove(nx: number, nz: number, h: number) {
  const to = playerWorld(nx, nz, h);
  anim = {
    type: "playerMove",
    nx, nz, toH: h, arc: CONFIG.jumpHeight,
    pmFrom: player.mesh.position.clone(),
    pmTo: new THREE.Vector3(to.x, to.y, to.z),
    t: 0,
    ms: CONFIG.moveMs,
  };
  logMsg(`${h >= 1 ? "乗り移り" : "歩き"}→(${nx},${nz}) 段${h}`);
}

// ===== リフト（持ち上げ / 設置） ================================
function handleLift() {
  if (anim || over) return;
  if (player.carrying) {
    const t = placeTarget();
    if (!t) return; // 置ける場所が無い（向きを変えてから）
    const die = player.carrying;
    pushDie(t.gx, t.gz, die); // 前方スタックの上に積む（gx/gz/y 設定）
    dice.push(die);
    player.carrying = null;
    ghost.visible = false;
    sfx(220, 0.09, "square", 0.04);
    logMsg(`設置 目${die.orient.top}→(${t.gx},${t.gz})`);
    chain = 0;
    resolveMatches();
  } else {
    // 向いている前方（隣）の最上段ダイスを持ち上げる。アクイの位置・段は変わらない
    const f = player.facing;
    const tx = player.gx + f.dx;
    const tz = player.gz + f.dz;
    if (!inBounds(tx, tz)) return;
    const die = topDie(tx, tz);
    if (!die || die.sinking) return;
    popDie(tx, tz);
    const idx = dice.indexOf(die);
    if (idx >= 0) dice.splice(idx, 1);
    // せり上がり途中なら中断して通常状態に
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i].kind === "rise" && effects[i].mesh === die.mesh) {
        effects.splice(i, 1);
      }
    }
    die.mesh.scale.set(1, 1, 1);
    player.carrying = die;
    sfx(360, 0.09, "square", 0.04, 540);
    logMsg(`持上げ 目${die.orient.top} (${tx},${tz})`);
  }
}

// ジャンプ: 乗っている最上段サイコロごと真上に跳ぶ。滞空中に矢印で隣の上へ着地＝積む
function tryJump() {
  if (anim || over) return;
  let jd: Die | null = null;
  if (height(player.gx, player.gz) >= 1) {
    const t = topDie(player.gx, player.gz);
    if (t && !t.sinking) jd = t;
  }
  anim = {
    type: "jump",
    baseGX: player.gx,
    baseGZ: player.gz,
    hx: player.gx, // 着地先（初期はその場。空中で矢印を押すと変わる）
    hz: player.gz,
    baseY: player.mesh.position.y,
    jumpDie: jd,
    jumpBaseQuat: jd ? jd.mesh.quaternion.clone() : undefined,
    t: 0,
    ms: CONFIG.hopMs,
  };
  if (jd) popDie(player.gx, player.gz); // 跳んでいる間は元マスから外す
  sfx(320, 0.2, "sine", 0.05, 200);
  logMsg(jd ? `ジャンプ↑ 目${jd.orient.top}` : "ジャンプ↑");
}

// ===== アニメ完了 ===============================================
function finishAnim() {
  const a = anim!;
  anim = null;

  if (a.type === "dieRoll") {
    const die = a.die!;
    const dir = a.dir!;
    const q = new THREE.Quaternion().setFromAxisAngle(dir.axis, dir.angle);
    die.mesh.quaternion.copy(q.multiply(a.baseQuat!));
    die.orient = dir.logic(die.orient);
    pushDie(a.nx!, a.nz!, die); // 隣スタックの上に積む（gx/gz/y 設定）
    if (a.carry) {
      player.gx = a.nx!;
      player.gz = a.nz!;
      player.h = height(a.nx!, a.nz!); // 積んだ後の段数
    }
    placeDevil();
    chain = 0;
    resolveMatches();
  } else if (a.type === "dieSlide") {
    const die = a.die!;
    pushDie(a.nx!, a.nz!, die); // 押し出し先に積む（先が1段なら2段目）
    player.gx = a.pToCell!.gx;
    player.gz = a.pToCell!.gz;
    player.h = height(player.gx, player.gz); // 抜けた後の段数（床=0 / 残り土台）
    placeDevil();
    chain = 0;
    resolveMatches();
  } else if (a.type === "jump") {
    const jd = a.jumpDie;
    let gx = a.hx!;
    let gz = a.hz!;
    if (jd) {
      if (height(gx, gz) >= MAX_STACK) {
        gx = a.baseGX!; // 積めない → 元へ戻す
        gz = a.baseGZ!;
      }
      // 隣へ移動したぶん、その方向に1回転（上面が変わる）— tick の補間と最終値を一致させる
      const ddx = gx - a.baseGX!;
      const ddz = gz - a.baseGZ!;
      const rd = Object.values(DIRS).find((d) => d.dx === ddx && d.dz === ddz);
      if (rd) {
        jd.orient = rd.logic(jd.orient);
        const q = new THREE.Quaternion().setFromAxisAngle(rd.axis, rd.angle);
        jd.mesh.quaternion.copy(q.multiply(a.jumpBaseQuat!));
      } else {
        jd.mesh.quaternion.copy(a.jumpBaseQuat!);
      }
      pushDie(gx, gz, jd); // 隣スタックの上に積む（y も設定）
      player.gx = gx;
      player.gz = gz;
    } else {
      // 素ジャンプ：2段未満のマスに乗る。乗れないなら元へ
      if (height(gx, gz) >= MAX_STACK) {
        gx = a.baseGX!;
        gz = a.baseGZ!;
      }
      player.gx = gx;
      player.gz = gz;
    }
    player.h = height(player.gx, player.gz);
    placeDevil();
    chain = 0;
    resolveMatches();
  } else {
    // playerMove（乗り移り / 床歩き）
    player.gx = a.nx!;
    player.gz = a.nz!;
    player.h = a.toH ?? height(a.nx!, a.nz!);
    placeDevil();
  }
}

// ===== マッチ判定 ===============================================
// - 上面が同じダイスを「目の数 以上」連結すると消える（2〜6）
// - 「1」は単独では消えない。消滅グループに隣接した 1 があると全消し
function resolveMatches() {
  let chained = true;
  let removedAny = false;
  while (chained) {
    chained = false;
    const visited = new Set<Die>();
    const toRemove = new Set<Die>();
    let links = 0; // このパスで同時に成立した独立グループ数

    // 沈みかけ（消えかけ・cells外）も同じ段なら連結対象にする＝「沈みかけに隣接で消す」チェイン
    const ghosts = new Map<string, Die>();
    for (const d of dice) {
      if (d.sinking && !d.falling) {
        ghosts.set(`${d.gx},${d.gz},${d.sinking.level}`, d);
      }
    }

    // 同じ段（レベル）のサイコロ同士で連結。下段が消えると上が落ちて別レベルで再判定＝チェイン
    for (const die of dice) {
      if (visited.has(die) || die.sinking || die.falling || die.reserved) continue;
      const L = dieLevel(die); // この連結のレベル
      const value = die.orient.top;
      const group: Die[] = [];
      const stack: Die[] = [die];
      visited.add(die);
      while (stack.length) {
        const cur = stack.pop()!;
        group.push(cur);
        for (const dirName in DIRS) {
          const d = DIRS[dirName];
          const ax = cur.gx + d.dx;
          const az = cur.gz + d.dz;
          if (!inBounds(ax, az)) continue;
          // 隣マスの「同じ段」のサイコロ（cells外でも沈みかけ＝幽霊なら連結＝チェイン）
          const nb = cells[ax][az][L] ?? ghosts.get(`${ax},${az},${L}`);
          if (nb && !visited.has(nb) && !nb.falling && !nb.reserved && nb.orient.top === value) {
            visited.add(nb);
            stack.push(nb);
          }
        }
      }
      if (value >= 2 && group.length >= value) {
        links++; // 同時に成立したグループを1つカウント
        for (const g of group) if (!g.sinking) toRemove.add(g);
      }
    }

    if (toRemove.size) {
      const ones = dice.filter(
        (d) =>
          !d.sinking &&
          !d.falling &&
          !d.reserved &&
          d.orient.top === 1 &&
          topDie(d.gx, d.gz) === d
      );
      const touches = ones.some((one) =>
        Object.values(DIRS).some((d) => {
          const ax = one.gx + d.dx;
          const az = one.gz + d.dz;
          if (!inBounds(ax, az)) return false;
          const nb = topDie(ax, az);
          return nb !== null && toRemove.has(nb);
        })
      );
      if (touches) {
        for (const one of ones) {
          // ハッピーワン: アクイが乗っている最上段の「1」は消えない
          if (
            player.h >= 1 &&
            topDie(player.gx, player.gz) === one
          )
            continue;
          toRemove.add(one);
        }
      }
    }

    if (toRemove.size) {
      chained = true;
      removedAny = true;
      chain++;
      // チェーン中は消えかけを少し上に戻し、次のチェーンを繋ぎやすくする
      if (chain >= 2 && CONFIG.chainReturn > 0) {
        for (const d of dice) {
          if (d.sinking) d.sinking.t = Math.max(0, d.sinking.t - CONFIG.chainReturn);
        }
      }
      link = Math.max(1, links); // このパスの同時消し数
      // スコア = 消した数 × 10 × 連鎖倍率 × 同時消し（リンク）倍率
      score += toRemove.size * 10 * chain * link;
      logMsg(`消滅 ${toRemove.size}個 (CHAIN${chain} LINK${link})`);
      for (const die of toRemove) removeDie(die);
      if (link >= 2) {
        // リンク（同時消し）は高めの音で強調
        sfx(680 + chain * 100, 0.26, "triangle", 0.07, 1240 + chain * 100);
      } else {
        sfx(520 + chain * 120, 0.18, "triangle", 0.05, 880 + chain * 120);
      }
      updateHud();
    }
  }
  if (!removedAny) {
    link = 0; // この手では何も消えなかった
    updateHud();
  }
}

// 目の数ごとの消滅時間（目=3 で sinkMs、目が大きいほど長い）
function sinkDuration(value: number) {
  return Math.max(500, CONFIG.sinkMs + (value - 3) * CONFIG.sinkMsPerPip);
}

function removeDie(die: Die) {
  if (die.sinking) return; // すでに沈み中
  // すぐには消さず「沈み中」にする。半分沈むまでは足場・マッチ対象として残る
  const idx = dieLevel(die);
  die.sinking = {
    t: 0,
    level: idx,
    duration: sinkDuration(die.orient.top),
  };
  burst(die.mesh.position, FACE_COLORS[die.orient.top].bg);
  // 上に乗っているサイコロは下段に乗って一緒に沈み始める（半分で重力落下に切り替わる）
  const st = cells[die.gx][die.gz];
  for (let l = idx + 1; l < st.length; l++) st[l].reserved = true;
}

// 消滅エフェクト: 中央フラッシュ + 飛び散るパーティクル
function burst(pos: THREE.Vector3, color: string) {
  const col = new THREE.Color(color);

  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: col,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  flash.position.set(pos.x, Y, pos.z);
  flash.scale.setScalar(0.6);
  scene.add(flash);
  effects.push({ kind: "flash", mesh: flash, t: 0, ms: 360 });

  const pc = CONFIG.particleCount;
  for (let k = 0; k < pc; k++) {
    const sp = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: col,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    sp.position.set(pos.x, Y, pos.z);
    sp.scale.setScalar(0.28);
    const ang = (k / Math.max(1, pc)) * Math.PI * 2 + Math.random();
    const spd = CONFIG.particleSpeed + Math.random() * 0.9;
    const vel = new THREE.Vector3(
      Math.cos(ang) * spd,
      1.8 + Math.random() * 1.3,
      Math.sin(ang) * spd
    );
    scene.add(sp);
    effects.push({ kind: "particle", mesh: sp, vel, t: 0, ms: CONFIG.sinkMs + 140 });
  }
}

// ===== せり上がり / ゲームオーバー ==============================
function spawnInterval() {
  return Math.max(CONFIG.spawnMin, CONFIG.spawnBase - elapsed * CONFIG.spawnAccel);
}

function trySpawn() {
  // せり上がりは床（空マス＝0段）にのみ出現。全マス1段以上で GAME OVER
  const free: [number, number][] = [];
  for (let x = 0; x < GRID; x++)
    for (let z = 0; z < GRID; z++) if (height(x, z) === 0) free.push([x, z]);
  if (free.length === 0) {
    gameOver();
    return;
  }
  const [x, z] = free[Math.floor(Math.random() * free.length)];
  spawnDie(x, z);
  sfx(300, 0.08, "sine", 0.05, 440);
  chain = 0;
  resolveMatches();
}

function gameOver() {
  over = true;
  sfx(440, 0.5, "sawtooth", 0.06, 110);
  showMessage("GAME OVER", true);
}

// ===== HUD / メッセージ =========================================
const $score = document.getElementById("score")!;
const $count = document.getElementById("count")!;
const $chain = document.getElementById("chain")!;
const $link = document.getElementById("link")!;
const $message = document.getElementById("message")!;
const $log = document.getElementById("log")!;

// 操作・消滅ログ。logLines=画面表示（直近）、logAll=コピー用（全履歴）
const logLines: string[] = [];
const logAll: string[] = [];
function logMsg(msg: string) {
  if (!CONFIG.showLog) return;
  logLines.push(msg);
  if (logLines.length > 16) logLines.shift();
  logAll.push(msg);
  if (logAll.length > 500) logAll.shift();
  $log.textContent = logLines.join("\n");
  console.log("[XI] " + msg);
}

function updateHud() {
  $score.textContent = String(score);
  $count.textContent = String(dice.filter((d) => !d.sinking).length);
  $chain.textContent = String(chain);
  $link.textContent = String(link);
}

function showMessage(text: string, clickToRestart: boolean) {
  $message.textContent = text;
  $message.classList.remove("hidden");
  if (clickToRestart) {
    $message.onclick = () => {
      $message.classList.add("hidden");
      restart();
    };
  }
}

// ===== ループ ===================================================
let last = performance.now();
function tick(now: number) {
  const dt = now - last;
  last = now;

  // プレイヤー起因アニメ
  if (anim) {
    anim.t = Math.min(1, anim.t + dt / anim.ms);
    const t = anim.t;
    if (anim.type === "dieRoll") {
      const a = anim.dir!.angle * t;
      const q = new THREE.Quaternion().setFromAxisAngle(anim.dir!.axis, a);
      const rel = anim.baseRel!.clone().applyQuaternion(q);
      anim.die!.mesh.position.copy(anim.pivot!).add(rel);
      anim.die!.mesh.position.y -= (anim.drop ?? 0) * t; // 段差ぶん下る
      anim.die!.mesh.quaternion.copy(q.clone().multiply(anim.baseQuat!));
      if (anim.carry) {
        const c = anim.die!.mesh.position;
        player.mesh.position.set(c.x, c.y + HALF, c.z);
      }
    } else if (anim.type === "dieSlide") {
      const toY = dieWorldY(height(anim.nx!, anim.nz!));
      const willDrop = anim.fromY! > toY + 1e-6;
      if (willDrop) {
        // L字: まず水平に隣マスへ → そのマスで真下に落下（床にめり込まない）
        const moveT = Math.min(1, t / 0.6);
        const dropT = Math.max(0, (t - 0.6) / 0.4);
        anim.die!.mesh.position.set(
          lerp(anim.from!.x, anim.to!.x, moveT),
          lerp(anim.fromY!, toY, dropT),
          lerp(anim.from!.z, anim.to!.z, moveT)
        );
      } else {
        // 同じ高さ → そのまま平行移動
        anim.die!.mesh.position.set(
          lerp(anim.from!.x, anim.to!.x, t),
          anim.fromY!,
          lerp(anim.from!.z, anim.to!.z, t)
        );
      }
      player.mesh.position.set(
        lerp(anim.pFrom!.x, anim.pTo!.x, t),
        (anim.pH ?? 0) * CELL,
        lerp(anim.pFrom!.z, anim.pTo!.z, t)
      );
    } else if (anim.type === "jump") {
      // 真上に跳びつつ、着地先セル(hx,hz)へ空中で寄っていく
      const tw = gridToWorld(anim.hx!, anim.hz!);
      const cur = player.mesh.position;
      const k = Math.min(1, (dt / anim.ms) * 3);
      cur.x = lerp(cur.x, tw.x, k);
      cur.z = lerp(cur.z, tw.z, k);
      // 着地後のアクイ足元高さ（サイコロを積むなら +1 段）
      const topH = anim.jumpDie
        ? height(anim.hx!, anim.hz!) + 1
        : height(anim.hx!, anim.hz!);
      const line = lerp(anim.baseY!, topH * CELL, t);
      cur.y = line + Math.sin(Math.PI * t) * CONFIG.hopHeight;
      if (anim.jumpDie) {
        // アクイは乗っているサイコロの上 → サイコロ中心はアクイ足元の下
        anim.jumpDie.mesh.position.set(cur.x, cur.y - HALF, cur.z);
        // 移動方向に合わせて滞空中に転がす（着地方向は空中で変えられる）
        const ddx = anim.hx! - anim.baseGX!;
        const ddz = anim.hz! - anim.baseGZ!;
        const rd = Object.values(DIRS).find((d) => d.dx === ddx && d.dz === ddz);
        if (rd) {
          const q = new THREE.Quaternion().setFromAxisAngle(rd.axis, rd.angle * t);
          anim.jumpDie.mesh.quaternion.copy(q.multiply(anim.jumpBaseQuat!));
        } else {
          anim.jumpDie.mesh.quaternion.copy(anim.jumpBaseQuat!);
        }
      }
    } else {
      player.mesh.position.lerpVectors(anim.pmFrom!, anim.pmTo!, t);
      player.mesh.position.y += Math.sin(Math.PI * t) * (anim.arc ?? CONFIG.jumpHeight);
    }
    if (anim.t >= 1) finishAnim();
  }

  // 各種エフェクト（並行・複数可）
  const dts = dt / 1000;
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.t = Math.min(1, e.t + dt / e.ms);
    if (e.kind === "rise") {
      e.mesh.position.y = -CELL + e.t * (Y + CELL);
    } else if (e.kind === "flash") {
      e.mesh.scale.setScalar(lerp(0.6, CONFIG.flashScale, e.t));
      e.mesh.material.opacity = 1 - e.t;
    } else {
      // particle
      e.vel.y -= CONFIG.gravity * dts; // 重力
      e.mesh.position.addScaledVector(e.vel, dts);
      e.mesh.material.opacity = Math.max(0, 1 - e.t);
      e.mesh.scale.setScalar(0.28 * (1 - e.t * 0.5));
    }

    if (e.t >= 1) {
      if (e.kind === "rise") {
        e.mesh.position.y = Y;
        e.mesh.scale.set(1, 1, 1);
      } else {
        scene.remove(e.mesh);
        e.mesh.material.dispose();
      }
      effects.splice(i, 1);
    }
  }

  // 沈み中ダイスの進行（目ごとの duration でそのまま沈む。縮小なし）
  for (let i = dice.length - 1; i >= 0; i--) {
    const die = dice[i];
    if (!die.sinking) continue;
    die.sinking.t = Math.min(1, die.sinking.t + dt / die.sinking.duration);
    const t = die.sinking.t;
    die.mesh.position.y = dieWorldY(die.sinking.level) - t * CELL * CONFIG.sinkDepth;
    const st = cells[die.gx][die.gz];
    const myIdx = st.indexOf(die);
    // 上に乗った reserved サイコロは下段に乗って一緒に沈む（半分まで）
    if (myIdx >= 0) {
      for (let l = myIdx + 1; l < st.length; l++) {
        if (st[l].reserved) {
          st[l].mesh.position.y = die.mesh.position.y + (l - myIdx) * CELL;
        }
      }
    }
    // 半分沈んだら当たり判定を失う：cells除去 → 上段は reserved を解除して重力落下へ
    if (t >= CONFIG.sinkPlayable && myIdx >= 0) {
      st.splice(myIdx, 1);
      for (let l = myIdx; l < st.length; l++) {
        st[l].reserved = false;
        if (!st[l].falling) st[l].falling = { toY: dieWorldY(l), vy: 0 };
      }
    }
    // 完全に沈みきったら除去
    if (t >= 1) {
      scene.remove(die.mesh);
      dice.splice(i, 1);
    }
  }

  // 落下中サイコロ（土台が消えて落ちる）。重力で落ち、着地でチェーン判定
  let landed = false;
  for (let i = dice.length - 1; i >= 0; i--) {
    const die = dice[i];
    if (!die.falling) continue;
    die.falling.vy += CONFIG.fallGravity * dts;
    die.mesh.position.y -= die.falling.vy * dts;
    if (die.mesh.position.y <= die.falling.toY) {
      die.mesh.position.y = die.falling.toY;
      die.falling = undefined;
      landed = true;
      logMsg(`落下着地 目${die.orient.top}→(${die.gx},${die.gz})`);
      // 押しつぶし: 着地マスにまだ沈みアニメ中(cells外)のサイコロが残っていたら即消す
      for (let j = dice.length - 1; j >= 0; j--) {
        const o = dice[j];
        if (
          o !== die &&
          o.sinking &&
          o.gx === die.gx &&
          o.gz === die.gz &&
          cells[o.gx][o.gz].indexOf(o) === -1
        ) {
          scene.remove(o.mesh);
          dice.splice(j, 1);
          logMsg(`押しつぶし (${o.gx},${o.gz})`);
        }
      }
    }
  }
  if (landed && !anim) resolveMatches(); // 落ちて着地した結果での再マッチ＝チェイン

  // 足元のサイコロが沈み/落下中なら追従。通常なら重みで少し沈める。段数が減れば落ちる
  if (!anim) {
    const fd = topDie(player.gx, player.gz);
    // 前フレームに重みで沈めたサイコロを元の高さへ戻す
    if (
      weightedDie &&
      weightedDie !== fd &&
      !weightedDie.sinking &&
      !weightedDie.falling
    ) {
      const wl = dieLevel(weightedDie);
      if (wl >= 0) weightedDie.mesh.position.y = dieWorldY(wl);
    }
    weightedDie = null;

    if (fd && (fd.sinking || fd.falling || fd.reserved)) {
      player.h = height(player.gx, player.gz);
      player.mesh.position.y = fd.mesh.position.y + HALF; // 沈む/落ちるサイコロの上面に追従
    } else if (fd) {
      // 通常のサイコロに乗っている → キャラの重みで少し沈める
      player.h = height(player.gx, player.gz);
      const l = dieLevel(fd);
      const sunk = dieWorldY(l) - CONFIG.weightSink;
      fd.mesh.position.y = sunk;
      player.mesh.position.y = sunk + HALF;
      weightedDie = fd;
    } else if (player.h !== height(player.gx, player.gz)) {
      player.h = height(player.gx, player.gz);
      placeDevil();
    }
  }

  // 上部プレビュー: 今乗っているサイコロに連動（転がし中は転がるサイコロ、乗り移ったら切替）
  let pvTarget: Die | null;
  if (anim && anim.type === "dieRoll" && anim.carry) {
    pvTarget = anim.die ?? null; // 転がし中は転がっているサイコロに連動
  } else if (anim && anim.type === "jump" && anim.jumpDie) {
    pvTarget = anim.jumpDie; // ジャンプ中は担いでいるサイコロ
  } else {
    pvTarget = topDie(player.gx, player.gz); // 通常は足元のサイコロ
  }
  if (pvTarget && !pvTarget.sinking && !pvTarget.falling) {
    miniPivot.visible = true;
    miniDie.quaternion.copy(pvTarget.mesh.quaternion);
  } else {
    miniPivot.visible = false;
  }

  // せり上がりタイマー
  if (!over && !anim) {
    elapsed += dt;
    spawnTimer += dt;
    if (spawnTimer >= spawnInterval()) {
      spawnTimer = 0;
      trySpawn();
    }
  }

  syncCarry();
  updateGhost();

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ===== 初期化 / リスタート ======================================
function restart() {
  GRID = CONFIG.grid; // 盤面サイズの変更を反映
  for (const die of [...dice]) scene.remove(die.mesh);
  dice.length = 0;
  rebuildCells();
  buildStage();
  for (const e of effects) {
    scene.remove(e.mesh);
    if (e.kind === "flash" || e.kind === "particle") e.mesh.material.dispose();
  }
  effects.length = 0;
  if (player.carrying) {
    scene.remove(player.carrying.mesh);
    player.carrying = null;
  }
  ghost.visible = false;
  score = 0;
  chain = 0;
  link = 0;
  elapsed = 0;
  spawnTimer = 0;
  over = false;

  const free: [number, number][] = [];
  for (let x = 0; x < GRID; x++)
    for (let z = 0; z < GRID; z++) free.push([x, z]);
  for (let i = free.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [free[i], free[j]] = [free[j], free[i]];
  }
  const count = Math.min(CONFIG.startDice, free.length);
  for (let i = 0; i < count; i++) makeDie(free[i][0], free[i][1]);

  player.gx = dice[0].gx;
  player.gz = dice[0].gz;
  player.h = height(player.gx, player.gz);
  placeDevil();
  player.mesh.rotation.y = player.facing.yaw;
  updateHud();
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===== パラメータ調整パネル（lil-gui）===========================
function buildGui() {
  const gui = new GUI({ title: "XI Params" });

  const fBoard = gui.addFolder("Board / Difficulty（Restart で反映）");
  fBoard.add(CONFIG, "grid", 3, 12, 1).name("盤面サイズ").onFinishChange(restart);
  fBoard.add(CONFIG, "startDice", 0, 40, 1).name("開始ダイス数").onFinishChange(restart);
  fBoard.add(CONFIG, "showLog").name("ログ表示").onChange((v: boolean) => {
    if (!v) {
      logLines.length = 0;
      $log.textContent = "";
    }
  });
  fBoard
    .add(
      {
        copyLog() {
          const text = logAll.join("\n");
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(text);
            window.alert("ログをクリップボードにコピーしました");
          } else {
            window.prompt("ログをコピーしてください", text);
          }
        },
      },
      "copyLog"
    )
    .name("📋 ログをコピー");

  const fTime = gui.addFolder("Timing (ms)");
  fTime.add(CONFIG, "rollMs", 30, 1200, 10).name("転がし");
  fTime.add(CONFIG, "moveMs", 30, 1200, 10).name("歩き / 乗り移り");
  fTime.add(CONFIG, "hopMs", 60, 2000, 10).name("ジャンプ(Z)");
  fTime.add(CONFIG, "sinkMs", 500, 12000, 100).name("消滅(基準/目3)");
  fTime.add(CONFIG, "sinkMsPerPip", 0, 2000, 10).name("目ごと増分");
  fTime.add(CONFIG, "sinkPlayable", 0.1, 1, 0.05).name("乗れる沈み割合");
  fTime.add(CONFIG, "riseMs", 100, 4000, 10).name("せり上がり(出現)");

  const fSpawn = gui.addFolder("Spawn");
  fSpawn.add(CONFIG, "spawnBase", 1000, 30000, 100).name("間隔(開始)");
  fSpawn.add(CONFIG, "spawnMin", 500, 20000, 100).name("間隔(最短)");
  fSpawn.add(CONFIG, "spawnAccel", 0, 0.2, 0.001).name("短縮レート");

  const fFx = gui.addFolder("Motion / Effects");
  fFx.add(CONFIG, "jumpHeight", 0, 2, 0.01).name("小ジャンプ高さ");
  fFx.add(CONFIG, "hopHeight", 0, 3, 0.05).name("ホップ高さ(Z)");
  fFx.add(CONFIG, "liftHeight", 0.4, 2.5, 0.01).name("持ち上げ高さ");
  fFx.add(CONFIG, "sinkDepth", 0.5, 5, 0.05).name("沈み込み深さ");
  fFx.add(CONFIG, "flashScale", 1, 10, 0.1).name("フラッシュ拡大");
  fFx.add(CONFIG, "particleCount", 0, 60, 1).name("パーティクル数");
  fFx.add(CONFIG, "particleSpeed", 0, 10, 0.1).name("パーティクル初速");
  fFx.add(CONFIG, "gravity", 0, 40, 0.5).name("重力(粒子)");
  fFx.add(CONFIG, "fallGravity", 0, 60, 1).name("落下重力(サイコロ)");
  fFx.add(CONFIG, "weightSink", 0, 0.3, 0.01).name("重み沈み");
  fFx.add(CONFIG, "chainReturn", 0, 0.5, 0.01).name("チェーン戻し");
  fFx.add(CONFIG, "sfxVolume", 0, 0.4, 0.005).name("効果音量");

  const io = {
    export() {
      const json = JSON.stringify(CONFIG, null, 2);
      console.log("[XI CONFIG]\n" + json);
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(json);
        window.alert("CONFIG を JSON でクリップボードにコピーしました（コンソールにも出力）");
      } else {
        window.prompt("この CONFIG をコピーしてください", json);
      }
    },
    import() {
      const s = window.prompt("CONFIG の JSON を貼り付けてください");
      if (!s) return;
      try {
        const obj = JSON.parse(s);
        Object.assign(CONFIG, obj);
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
        restart();
      } catch {
        window.alert("JSON の解析に失敗しました");
      }
    },
    restart() {
      restart();
    },
  };
  gui.add(io, "export").name("⬇ Export (copy JSON)");
  gui.add(io, "import").name("⬆ Import (paste JSON)");
  gui.add(io, "restart").name("⟳ Restart");
}

buildGui();
restart();
requestAnimationFrame(tick);
