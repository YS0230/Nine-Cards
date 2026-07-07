// 3D 牌桌場景（three.js）：以 PersonalGameState 為唯一輸入來源，
// 每次 sync() 重新計算所有牌的目標位置/朝向，render loop 以插值平滑移動。
// 點選（raycast）只回報「哪張牌被點了」，合法性仍完全交給伺服器判定。
import * as THREE from 'three';
import {
  cardImageBase,
  type Card as CardT,
  type PersonalGameState,
  type PublicPlayer,
} from '@nine-cards/shared';

export interface SceneInput {
  g: PersonalGameState;
  selectedId: string | null;
  pickableIds: Set<string>; // 此刻可點選（出牌）的我方牌 id
  canPass: boolean; // 自摸保護中：點中央那張＝不吃打出（pass）
}

export interface SceneCallbacks {
  onPick: (cardId: string) => void;
  onPass: () => void;
}

// 牌尺寸：卡面圖為 69×247 的長條牌
const CARD_H = 1.4;
const CARD_W = CARD_H * (69 / 247);
const CARD_D = 0.05;

// 各區域座標（桌面 y=0，+z 朝向自己）
const MY_HAND_Z = 3.95;
const MY_PUBLIC_Z = 2.7; // 我的公開區（吃牌對子＋死牌）
const OPP_TOP = { hand: -4.35, pub: -3.1 };
// 側邊暗牌橫向（長軸朝畫面外）刻意出血到視野邊緣，只需看得出餘牌數
const OPP_SIDE = { hand: 3.7, pub: 2.35 };
const DECK_POS = new THREE.Vector3(0, 0, -1.35); // 牌堆：桌面中央偏遠側，橫放堆疊
const CLAIM_POS = new THREE.Vector3(0, 1.28, 0.55);

// 一張牌的顯示目標
interface CardTarget {
  key: string;
  card: CardT | null; // null＝牌背（他人暗牌／牌堆）
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number; // 棄牌縮小以容納更多張
  spawn?: THREE.Vector3; // 新 mesh 的起點（出牌從出牌者方位飛入；未指定＝牌堆）
  pickable: boolean;
  isPass: boolean;
  selected: boolean;
}

interface CardNode {
  mesh: THREE.Mesh;
  faceMat: THREE.MeshLambertMaterial;
  base: string | null; // 目前貼圖檔名（牌背為 null）
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  targetScale: number;
}

// 平放桌面（face 朝上）；spin＝繞垂直軸旋轉。'YXZ' 使 spin 作用於世界 Y 軸
const quatFlatUp = (spin = 0) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, spin, 0, 'YXZ'));
const quatFlatDown = (spin = 0) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, spin, 0, 'YXZ'));
// 立起、面朝自己（略後仰對準俯視鏡頭）
const quatFacingMe = (tilt = -0.45) =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, 0, 0));

// 以牌 id 產生固定的微小旋轉抖動，讓棄牌看起來自然（不隨 re-render 亂跳）
function jitterOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 100) / 100 - 0.5) * 0.12;
}

export class TableScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private container: HTMLElement;
  private callbacks: SceneCallbacks;
  private raf = 0;
  private clock = new THREE.Clock();
  private resizeObs: ResizeObserver;

  private cardGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D);
  private sideMat = new THREE.MeshLambertMaterial({ color: 0xe3d9c2 });
  private backMat: THREE.MeshLambertMaterial;
  private nodes = new Map<string, CardNode>();
  private textures = new Map<string, THREE.Texture>();
  private loader = new THREE.TextureLoader();
  private everSynced = false; // 首次同步不做飛牌動畫（重連/切回 3D 直接就定位）
  private prevDiscardLen = 0; // 上次同步的棄牌數：判斷哪些是「剛打出」的牌
  private prevActorSeat: number | null = null; // 上次同步時最可能出牌的座位（吃牌者＞行動者）

  // 對手名牌（Sprite）：seat → { sprite, key }，key 變了才重畫 canvas
  private labels = new Map<number, { sprite: THREE.Sprite; key: string }>();
  // 待吃牌底下的光圈（提示可互動／倒數中）
  private claimRing: THREE.Mesh;

  private onPointerDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  private onPointerUp = (e: PointerEvent) => {
    if (!this.downAt) return;
    const dx = e.clientX - this.downAt.x;
    const dy = e.clientY - this.downAt.y;
    const dt = performance.now() - this.downAt.t;
    this.downAt = null;
    if (dx * dx + dy * dy > 100 || dt > 600) return; // 拖曳/長按不視為點選
    this.pick(e.clientX, e.clientY);
  };
  private downAt: { x: number; y: number; t: number } | null = null;

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 60);

    // 光源：半球光打底＋方向光給牌面立體感
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2c4a38, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(4, 10, 6);
    this.scene.add(dir);

    // 桌面
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(9.6, 0.5, 12.4),
      new THREE.MeshLambertMaterial({ color: 0x1e6f4c }),
    );
    table.position.y = -0.25;
    this.scene.add(table);

    this.backMat = new THREE.MeshLambertMaterial({ map: makeBackTexture() });

    // 待吃牌的光圈
    this.claimRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffd24a,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false, // 待吃牌下方現在是棄牌區，光圈直接疊在牌上顯示
      }),
    );
    this.claimRing.renderOrder = 500;
    this.claimRing.rotation.x = -Math.PI / 2;
    this.claimRing.visible = false;
    this.scene.add(this.claimRing);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.remove();
    this.renderer.dispose();
    this.cardGeo.dispose();
    for (const t of this.textures.values()) t.dispose();
    for (const n of this.nodes.values()) n.faceMat.dispose();
    for (const l of this.labels.values()) l.sprite.material.map?.dispose();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // 直式手機（窄畫面）把鏡頭拉高拉遠，確保左右兩側對手入鏡；
    // 俯角壓低讓桌面填滿畫面，避免上方露出大片背景
    const f = Math.min(1.55, Math.max(1, 0.68 / aspect));
    this.camera.position.set(0, 9.4 * f, 6.0 * f);
    this.camera.lookAt(0, 0, 0.2);
    this.camera.updateProjectionMatrix();
  }

  /** 依最新遊戲狀態重算所有牌的目標位置（由 React effect 呼叫）。 */
  sync(input: SceneInput) {
    const targets = this.computeTargets(input);
    const seen = new Set<string>();

    for (const t of targets) {
      seen.add(t.key);
      let node = this.nodes.get(t.key);
      if (!node) {
        const faceMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        const mats = [this.sideMat, this.sideMat, this.sideMat, this.sideMat, faceMat, this.backMat];
        const mesh = new THREE.Mesh(this.cardGeo, mats);
        // 新牌起點：出牌者方位（target.spawn）＞牌堆（發牌感）；
        // 首次同步（重連/切回 3D）直接放在定位，不做整桌飛牌動畫
        const spawn = this.everSynced
          ? (t.spawn ?? new THREE.Vector3(DECK_POS.x, 0.4, DECK_POS.z))
          : t.pos;
        mesh.position.copy(spawn);
        mesh.quaternion.copy(quatFlatDown());
        this.scene.add(mesh);
        node = {
          mesh,
          faceMat,
          base: null,
          targetPos: new THREE.Vector3(),
          targetQuat: new THREE.Quaternion(),
          targetScale: 1,
        };
        this.nodes.set(t.key, node);
      }
      // 牌面貼圖：牌背朝上者不需要；同一 key 換牌（新局重用 id）時換貼圖
      const base = t.card ? cardImageBase(t.card) : null;
      if (base !== node.base) {
        node.base = base;
        node.faceMat.map = base ? this.faceTexture(base) : this.backMat.map;
        node.faceMat.needsUpdate = true;
      }
      node.targetPos.copy(t.pos);
      node.targetQuat.copy(t.quat);
      node.targetScale = t.scale;
      node.faceMat.emissive.setHex(t.selected ? 0x7a5c00 : 0x000000);
      node.mesh.userData.cardId = t.card?.id ?? null;
      node.mesh.userData.pickable = t.pickable;
      node.mesh.userData.isPass = t.isPass;
    }

    // 移除已不在桌上的牌
    for (const [key, node] of this.nodes) {
      if (seen.has(key)) continue;
      this.scene.remove(node.mesh);
      node.faceMat.dispose();
      this.nodes.delete(key);
    }

    this.syncLabels(input.g);
    // 光圈：有待吃牌時顯示在其正下方
    this.claimRing.visible = !!input.g.pendingClaim;
    this.claimRing.position.set(CLAIM_POS.x, 0.02, CLAIM_POS.z);

    // 供下次同步判斷「剛打出的牌從誰那邊飛出」
    this.everSynced = true;
    this.prevDiscardLen = input.g.discardPile.length;
    this.prevActorSeat = input.g.eating?.seat ?? input.g.currentTurnSeat;
  }

  // 各座位的「出牌起點」：牌從該玩家的方位飛向桌面
  private seatSpawn(seat: number, mySeat: number, seatCount: number): THREE.Vector3 {
    if (seat === mySeat) return new THREE.Vector3(0, 0.9, 3.7);
    const zone = this.zoneOf((mySeat - seat + seatCount) % seatCount, seatCount);
    if (zone === 'top') return new THREE.Vector3(0, 0.5, -4.4);
    return new THREE.Vector3(zone === 'left' ? -4.2 : 4.2, 0.5, 0);
  }

  // ── 佈局：把遊戲狀態轉成每張牌的目標位置 ──────────────────────
  private computeTargets(input: SceneInput): CardTarget[] {
    const { g, selectedId, pickableIds, canPass } = input;
    const out: CardTarget[] = [];
    const mySeat = g.you.seat;
    const seatCount = g.players.length;
    const turnDist = (seat: number) => (mySeat - seat + seatCount) % seatCount;

    const push = (
      key: string,
      card: CardT | null,
      pos: THREE.Vector3,
      quat: THREE.Quaternion,
      opts: Partial<Pick<CardTarget, 'pickable' | 'isPass' | 'selected' | 'scale' | 'spawn'>> = {},
    ) =>
      out.push({
        key,
        card,
        pos,
        quat,
        scale: opts.scale ?? 1,
        spawn: opts.spawn,
        pickable: opts.pickable ?? false,
        isPass: opts.isPass ?? false,
        selected: opts.selected ?? false,
      });

    // 佔用桌面中央的特殊牌（待吃／吃牌中）不重複畫在別區
    const claimId = g.pendingClaim?.card.id ?? null;
    const eatingId = g.eating?.card.id ?? null;

    // 牌堆：橫放（長軸沿 x）攤塌在桌面中央——像倒下的牌疊由遠而近鱗片式平攤，
    // 一張疊一張瀉向玩家方向；張數與剩餘量成正比，抽牌後攤疊逐漸縮短塌平
    const deckShown = Math.min(14, g.deckCount > 0 ? Math.max(1, Math.round(g.deckCount / 7)) : 0);
    for (let i = 0; i < deckShown; i++) {
      const pos = new THREE.Vector3(
        DECK_POS.x + (i % 2 ? 0.045 : -0.045), // 微錯位，看起來是自然倒塌
        0.03 + i * 0.012,
        -1.95 + i * 0.15,
      );
      push(`deck:${i}`, null, pos, quatFlatDown(Math.PI / 2 + 0.05 * ((i % 3) - 1)), {
        spawn: pos,
      });
    }

    // 棄牌區：牌堆攤疊前方的網格（縮小 0.7、每列 10 張，由遠而近；平放面朝上）。
    // 超過 3 列的極端情況疊在最後一列上（y 遞增讓新牌在上），避免蔓延到我的區域。
    // 剛打出的牌（index ≥ 上次棄牌數）從出牌者方位飛入
    const actorSpawn =
      this.prevActorSeat != null ? this.seatSpawn(this.prevActorSeat, mySeat, seatCount) : undefined;
    g.discardPile.forEach((card, i) => {
      if (card.id === claimId || card.id === eatingId) return;
      const col = i % 10;
      const row = Math.floor(i / 10);
      push(
        `c:${card.id}`,
        card,
        new THREE.Vector3(
          -1.67 + col * 0.37,
          0.03 + row * 0.012,
          0.4 + Math.min(row, 2) * 0.58,
        ),
        quatFlatUp(jitterOf(card.id)),
        { scale: 0.7, spawn: i >= this.prevDiscardLen ? actorSpawn : undefined },
      );
    });

    // 待吃/自摸保護中的牌：懸浮在中央、面向自己；從打出它的玩家方位飛入
    if (g.pendingClaim) {
      push(`c:${g.pendingClaim.card.id}`, g.pendingClaim.card, CLAIM_POS.clone(), quatFacingMe(), {
        pickable: canPass,
        isPass: canPass,
        spawn: this.seatSpawn(g.pendingClaim.fromSeat, mySeat, seatCount),
      });
    }

    // 吃牌中：牌懸浮在吃牌者座位前方（等待其打出定案）；自己吃則浮在自己手牌前
    if (g.eating && g.eating.card.id !== claimId) {
      const pos =
        g.eating.seat === mySeat
          ? new THREE.Vector3(0, 1.05, 1.8)
          : (() => {
              const anchor = this.zoneAnchor(turnDist(g.eating.seat), seatCount);
              return new THREE.Vector3(anchor.x * 0.55, 1.0, anchor.z * 0.55);
            })();
      push(`c:${g.eating.card.id}`, g.eating.card, pos, quatFacingMe(-0.35));
    }

    // ── 我的區域 ──
    const deadIdSet = new Set(g.you.deadIds);
    const myDead = g.you.deadIds
      .map((id) => g.you.hand.find((c) => c.id === id))
      .filter((c): c is CardT => !!c);
    const myHand = g.you.hand.filter((c) => !deadIdSet.has(c.id));

    // 公開區：吃牌對子（兩張略疊）＋死牌單張，靠左往右排；新牌從我的手牌處滑出
    const mySpawn = this.seatSpawn(mySeat, mySeat, seatCount);
    let px = -3.0;
    for (const [i, pair] of g.you.melds.entries()) {
      for (const [j, card] of pair.entries()) {
        push(`c:${card.id}`, card, new THREE.Vector3(px + j * 0.44, 0.03, MY_PUBLIC_Z), quatFlatUp(0.03 * (i % 2 ? 1 : -1)), { spawn: mySpawn });
      }
      px += 0.44 + 0.68;
    }
    for (const card of myDead) {
      if (card.id === eatingId) continue;
      push(`c:${card.id}`, card, new THREE.Vector3(px, 0.03, MY_PUBLIC_Z), quatFlatUp(jitterOf(card.id)), {
        pickable: pickableIds.has(card.id),
        selected: selectedId === card.id,
        spawn: mySpawn,
      });
      px += 0.68;
    }

    // 暗手牌：立起面向自己，置中排開
    const n = myHand.length;
    const spacing = n > 1 ? Math.min(0.56, 5.6 / (n - 1)) : 0;
    const x0 = -((n - 1) * spacing) / 2;
    myHand.forEach((card, i) => {
      const selected = selectedId === card.id;
      push(
        `c:${card.id}`,
        card,
        new THREE.Vector3(x0 + i * spacing, 0.66 + (selected ? 0.34 : 0), MY_HAND_Z - (selected ? 0.3 : 0)),
        quatFacingMe(),
        { pickable: pickableIds.has(card.id), selected },
      );
    });

    // ── 對手區域 ──
    for (const p of g.players) {
      if (p.seat === mySeat) continue;
      const zone = this.zoneOf(turnDist(p.seat), seatCount);
      this.layoutOpponent(p, zone, eatingId, this.seatSpawn(p.seat, mySeat, seatCount), push);
    }

    return out;
  }

  // 對手座位方位：下家（輪替距離 1）＝右、上家＝左、其餘＝對面；兩人局對家在對面
  private zoneOf(dist: number, seatCount: number): 'left' | 'right' | 'top' {
    if (seatCount === 2) return 'top';
    if (dist === 1) return 'right';
    if (dist === seatCount - 1) return 'left';
    return 'top';
  }

  private zoneAnchor(dist: number, seatCount: number): { x: number; z: number } {
    const zone = this.zoneOf(dist, seatCount);
    if (zone === 'top') return { x: 0, z: -3.6 };
    return { x: zone === 'left' ? -2.9 : 2.9, z: 0 };
  }

  // 對手：暗牌一排（牌背朝上平放）＋公開區（吃牌對子/死牌，面朝上）
  private layoutOpponent(
    p: PublicPlayer,
    zone: 'left' | 'right' | 'top',
    eatingId: string | null,
    spawn: THREE.Vector3,
    push: (
      key: string,
      card: CardT | null,
      pos: THREE.Vector3,
      quat: THREE.Quaternion,
      opts?: { spawn?: THREE.Vector3 },
    ) => void,
  ) {
    // 沿著該側的排列方向：top 沿 x、side 沿 z
    const place = (offset: number, line: 'hand' | 'pub'): THREE.Vector3 => {
      if (zone === 'top')
        return new THREE.Vector3(offset, 0.03, line === 'hand' ? OPP_TOP.hand : OPP_TOP.pub);
      const x = (zone === 'left' ? -1 : 1) * (line === 'hand' ? OPP_SIDE.hand : OPP_SIDE.pub);
      return new THREE.Vector3(x, 0.03, offset);
    };
    const spin = zone === 'top' ? 0 : zone === 'left' ? -Math.PI / 2 : Math.PI / 2;

    // 暗牌置中排開。側邊座位橫放（長軸朝畫面外），外側牌身隱沒在視野邊緣，
    // 只需看得出剩幾張
    const hn = p.handCount;
    const hStep = zone === 'top' ? 0.44 : 0.42;
    const h0 = -((hn - 1) * hStep) / 2;
    for (let i = 0; i < hn; i++) {
      push(`h${p.seat}:${i}`, null, place(h0 + i * hStep, 'hand'), quatFlatDown(spin + jitterOf(`${p.seat}:${i}`) * 0.2));
    }

    // 公開區：由中心往外排；剛吃進的牌從該玩家方位滑入
    const pubCards: { card: CardT; group: number }[] = [];
    p.melds.forEach((pair, gi) => pair.forEach((c) => pubCards.push({ card: c, group: gi })));
    p.deadCards.forEach((c, di) => pubCards.push({ card: c, group: 100 + di }));
    const width = pubCards.length * 0.46;
    let off = -width / 2;
    let lastGroup = -1;
    for (const { card, group } of pubCards) {
      if (card.id === eatingId) continue;
      if (lastGroup !== -1 && group !== lastGroup) off += 0.2; // 組間留空隙
      lastGroup = group;
      push(`c:${card.id}`, card, place(off, 'pub'), quatFlatUp(spin + jitterOf(card.id)), { spawn });
      off += 0.46;
    }
  }

  // ── 對手名牌（Sprite）──────────────────────────────────────
  private syncLabels(g: PersonalGameState) {
    const mySeat = g.you.seat;
    const seatCount = g.players.length;
    const turnDist = (seat: number) => (mySeat - seat + seatCount) % seatCount;
    const relationOf = (seat: number) => {
      if (seatCount === 2) return '對家';
      const d = turnDist(seat);
      return d === 1 ? '下家' : d === seatCount - 1 ? '上家' : '對家';
    };
    const seen = new Set<number>();
    for (const p of g.players) {
      if (p.seat === mySeat) continue;
      seen.add(p.seat);
      const active = p.seat === g.currentTurnSeat;
      const badges = [
        p.isDealer ? '莊' : '',
        p.isTenpai ? '聽' : '',
        p.isXianggong ? '相公' : '',
        !p.connected ? '斷線' : '',
      ]
        .filter(Boolean)
        .join('·');
      const text = `${relationOf(p.seat)} ${p.name}　${p.score}頭${badges ? '　' + badges : ''}`;
      const key = `${text}|${active}`;
      let entry = this.labels.get(p.seat);
      if (!entry) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ transparent: true, depthTest: false }),
        );
        sprite.renderOrder = 999;
        this.scene.add(sprite);
        entry = { sprite, key: '' };
        this.labels.set(p.seat, entry);
      }
      if (entry.key !== key) {
        entry.key = key;
        entry.sprite.material.map?.dispose();
        const { texture, aspect } = makeLabelTexture(text, active);
        entry.sprite.material.map = texture;
        entry.sprite.material.needsUpdate = true;
        entry.sprite.scale.set(0.62 * aspect, 0.62, 1);
      }
      // 名牌位置：拉高放到牌組後方的桌沿，不擋住對家的牌；
      // 側邊座位放在該側上方偏內，避免超出直式視野
      const zone = this.zoneOf(turnDist(p.seat), seatCount);
      entry.sprite.position.set(
        zone === 'top' ? 0 : zone === 'left' ? -2.0 : 2.0,
        zone === 'top' ? 2.4 : 1.9,
        zone === 'top' ? -5.5 : -4.1,
      );
    }
    for (const [seat, entry] of this.labels) {
      if (seen.has(seat)) continue;
      entry.sprite.material.map?.dispose();
      this.scene.remove(entry.sprite);
      this.labels.delete(seat);
    }
  }

  // ── 每幀：位置/朝向插值＋光圈脈動 ─────────────────────────
  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const a = 1 - Math.exp(-9 * dt);
    for (const node of this.nodes.values()) {
      node.mesh.position.lerp(node.targetPos, a);
      node.mesh.quaternion.slerp(node.targetQuat, a);
      node.mesh.scale.setScalar(THREE.MathUtils.lerp(node.mesh.scale.x, node.targetScale, a));
    }
    if (this.claimRing.visible) {
      const t = this.clock.elapsedTime;
      const s = 1 + 0.08 * Math.sin(t * 4);
      this.claimRing.scale.set(s, s, 1);
      (this.claimRing.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.25 * Math.sin(t * 4);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ── 點選：raycast 找最近的可互動牌 ────────────────────────
  private pick(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const candidates = [...this.nodes.values()]
      .filter((n) => n.mesh.userData.pickable)
      .map((n) => n.mesh);
    const hit = ray.intersectObjects(candidates, false)[0];
    if (!hit) return;
    if (hit.object.userData.isPass) this.callbacks.onPass();
    else if (hit.object.userData.cardId) this.callbacks.onPick(hit.object.userData.cardId);
  }

  private faceTexture(base: string): THREE.Texture {
    let tex = this.textures.get(base);
    if (!tex) {
      tex = this.loader.load(`/cards/${base}.png`);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      this.textures.set(base, tex);
    }
    return tex;
  }
}

// 牌背貼圖：淺綠底＋深綠框線＋菱格紋（一次生成共用）
function makeBackTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 344;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c8e4bc';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(43,105,66,0.9)';
  ctx.lineWidth = 4;
  ctx.strokeRect(7, 7, c.width - 14, c.height - 14);
  ctx.strokeStyle = 'rgba(43,105,66,0.28)';
  ctx.lineWidth = 2;
  for (let y = -c.width; y < c.height + c.width; y += 22) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y + c.width);
    ctx.moveTo(c.width, y);
    ctx.lineTo(0, y + c.width);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 對手名牌貼圖：半透明圓角底＋文字；輪到該玩家時金框高亮
function makeLabelTexture(text: string, active: boolean): { texture: THREE.CanvasTexture; aspect: number } {
  const font = '600 30px system-ui, sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 44;
  const h = 60;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = active ? 'rgba(120,86,0,0.85)' : 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 14);
  ctx.fill();
  if (active) {
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: w / h };
}
