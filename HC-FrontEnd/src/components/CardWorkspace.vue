<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { t } from "../i18n";
import {
  cardGap,
  compact,
  dropSlots,
  nearestSlot,
  singleColumnWidth,
  type CardId,
  type DropSlot,
  type Rectangle,
} from "./cardLayout";
type Gesture = {
  edge: string;
  mode: "wetting" | "standard";
  pointerId: number;
  target: HTMLElement;
  clientX: number;
  clientY: number;
  scrollY: number;
  original: Rectangle;
  visibleX: number;
  visibleY: number;
  layout: Rectangle[];
  slots: DropSlot[];
  slot: DropSlot;
  maxDragY: number;
};
const props = defineProps<{
  mode: "wetting" | "standard";
}>();
const surface = ref<HTMLDivElement>();
const width = ref(0);
const cards = ref<Rectangle[]>([]);
const floating = shallowRef<Rectangle>();
const dropTarget = shallowRef<Rectangle>();
const active = ref<CardId | null>(null);
const raised = ref<CardId | null>(null);
const adapting = ref(false);
const reordering = ref(false);
const labels: Record<CardId, string> = {
  image: "nav.analysis",
  metrics: "analysis.metricsTitle",
  response: "chart.title",
  details: "analysis.details",
};
const minimumHeight: Record<CardId, number> = {
  image: 380,
  metrics: 520,
  response: 270,
  details: 280,
};
const edges = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
let gesture: Gesture | null = null;
let pending: PointerEvent | null = null;
let frame = 0;
let observer: ResizeObserver;
let resizeTimer: ReturnType<typeof setTimeout>;
const height = computed(() => {
  // 拖动时至少保留原画布高度，填空后也不会因页面缩短把滚动位置拉回。
  const baseline =
    active.value && gesture && !gesture.edge ? gesture.layout : [];
  const rectangles = [...cards.value, ...baseline];
  const bottoms = rectangles.map((card) => card.y + card.height);
  return Math.max(600, ...bottoms) + 20;
});
const displayedCards = computed(() => {
  // 活动卡跟手，排版仍由占位轮廓和其它卡片显示。
  const card = floating.value;
  if (!card) return cards.value;
  return cards.value.map((item) => (item.id === card.id ? card : item));
});

function cardStyle(card: Rectangle) {
  return {
    transform: `translate3d(${card.x}px, ${card.y}px, 0)`,
    width: `${card.width}px`,
    height: `${card.height}px`,
  };
}

function defaults(): Rectangle[] {
  // 双列让图像和指标同行。窄画布依次显示图像、指标、曲线和分析信息。
  const single = width.value < singleColumnWidth;
  const available = width.value - cardGap;
  const preferredLeft = Math.round(available * 0.59);
  const left = single ? width.value : Math.min(preferredLeft, available - 300);
  const right = single ? width.value : available - left;
  const plotHeight = Math.round(
    Math.max(430, Math.min(600, left * 0.56 + 110)),
  );
  const metricsHeight =
    right < 315 ? 735 : right < 380 ? 700 : right < 520 ? 650 : 580;
  const metricsY = single ? plotHeight + cardGap : 0;
  const responseY = single
    ? metricsY + metricsHeight + cardGap
    : plotHeight + cardGap;
  const responseHeight = props.mode === "wetting" ? 320 : 300;
  const detailsY = single
    ? responseY + responseHeight + cardGap
    : metricsHeight + cardGap;

  // 保持同一组卡片顺序，视图切换时同一 DOM 节点可平滑过渡。
  return [
    {
      id: "image",
      x: 0,
      y: 0,
      width: left,
      height: plotHeight,
    },
    {
      id: "metrics",
      x: single ? 0 : left + cardGap,
      y: metricsY,
      width: right,
      height: metricsHeight,
    },
    {
      id: "response",
      x: 0,
      y: responseY,
      width: left,
      height: responseHeight,
    },
    {
      id: "details",
      x: single ? 0 : left + cardGap,
      y: detailsY,
      width: right,
      height: 280,
    },
  ];
}

function minimum(card: Rectangle) {
  return minimumHeight[card.id];
}

type SavedCard = Omit<Rectangle, "id"> & {
  id: CardId | "root" | "results";
};

function migrateCards(saved: SavedCard[]): SavedCard[] {
  // 旧布局沿用当前模式的主要指标卡位置，并让其余卡片填上合并后留下的空位。
  const root = saved.find((card) => card.id === "root");
  const results = saved.find((card) => card.id === "results");
  if (!root || !results || saved.length !== 5) return saved;

  const anchor = props.mode === "wetting" ? root : results;
  const fallback = cards.value.find((card) => card.id === "metrics")!;
  const metrics: Rectangle = {
    ...anchor,
    id: "metrics",
    height: Math.max(root.height, results.height, fallback.height),
  };
  return saved
    .filter((card) => card.id !== root.id && card.id !== results.id)
    .concat(metrics);
}

function fitWidth(card: Rectangle, previousWidth: number): Rectangle {
  // 列宽按扣除间距后的空间同比适配。横跨画布的卡片保持横跨。
  const canKeepGap = previousWidth > cardGap && width.value > cardGap;
  const scale = canKeepGap
    ? (width.value - cardGap) / (previousWidth - cardGap)
    : width.value / previousWidth;
  const minWidth = Math.min(width.value, card.id === "image" ? 350 : 270);
  const fullWidth = card.width === previousWidth;
  const scaledWidth = fullWidth ? width.value : Math.round(card.width * scale);
  const nextWidth = Math.max(minWidth, Math.min(width.value, scaledWidth));
  const nextX = Math.min(width.value - nextWidth, card.x * scale);
  const adapted = {
    ...card,
    x: nextX,
    width: nextWidth,
  };
  adapted.height = Math.max(minimum(adapted), card.height);
  return adapted;
}

function key(mode = props.mode) {
  return "hydrocalc.cards.v2." + mode;
}
function remember(mode = props.mode) {
  // 仅保存布局，不写入分析记录；隐私模式禁用存储时仍能正常操作。
  try {
    const snapshot = JSON.stringify({
      width: width.value,
      cards: cards.value,
      packed: true,
    });
    localStorage.setItem(key(mode), snapshot);
  } catch {
    // 本地布局存储不可用时保留当前会话的交互。
  }
}
function restore() {
  // 模式切换仍保留完整的尺寸和位置过渡。
  reordering.value = false;
  cards.value = defaults();
  try {
    const saved = localStorage.getItem(key());
    if (!saved) return;
    const layout = JSON.parse(saved);
    if (!Number.isFinite(layout.width)) return;
    if (layout.width <= 0) return;
    if (!Array.isArray(layout.cards)) return;
    const candidates = migrateCards(layout.cards);
    const count = cards.value.length;
    if (candidates.length !== count) return;

    // 用默认卡片顺序匹配存档，同时拒绝重复或未知 ID。
    const ordered = cards.value.map((card) =>
      candidates.find((candidate) => candidate.id === card.id),
    );
    if (ordered.some((card) => !card)) return;
    const restored = ordered as Rectangle[];
    // 校验所有坐标，坏存储回退到默认布局；恢复时按可用宽度同比适配。
    const valid = restored.every((card) => {
      const coordinates = [card.x, card.y, card.width, card.height];
      return (
        coordinates.every(Number.isFinite) &&
        card.x >= 0 &&
        card.y >= 0 &&
        card.width >= 100 &&
        card.x + card.width <= layout.width &&
        card.height >= minimum(card)
      );
    });
    if (!valid) return;
    // 相同宽度下精确恢复已经收紧的排列。旧坐标或不同宽度重新适配并收紧。
    if (
      layout.packed === true &&
      candidates === layout.cards &&
      layout.width === width.value
    ) {
      cards.value = restored;
      return;
    }
    const adapted = restored.map((card) => fitWidth(card, layout.width));
    cards.value = compact(adapted, width.value);
  } catch {
    // JSON 损坏时沿用上面生成的默认布局。
  }
}
function reset() {
  finish();
  reordering.value = false;
  cards.value = defaults();
  remember();
}
function begin(event: PointerEvent, id: CardId, edge = "") {
  if (event.button !== 0) return;
  if (gesture) return;
  // 从起始布局一次性生成贴紧的落点，拖动中只挑选落点，不累计位移。
  const layout = cards.value.map((card) => ({
    ...card,
  }));
  const original = layout.find((card) => card.id === id)!;
  const slots = edge ? [] : dropSlots(layout, original, width.value);
  const landingYs = slots.map((target) => target.card.y);
  const maxDragY = Math.max(original.y, ...landingYs) + cardGap;
  const slot = {
    card: original,
    layout,
  };

  // 捕获指针，鼠标离开把手或缩放区后仍可连续操作。
  const target = event.currentTarget as HTMLElement;
  // 卡片还在落位时可以重新抓起，以下一帧接得上的屏幕坐标作为拖动起点。
  let visibleX = original.x;
  let visibleY = original.y;
  if (!edge) {
    const article = target.closest(".workspace-card")!;
    const box = article.getBoundingClientRect();
    const origin = surface.value!.getBoundingClientRect();
    visibleX = box.x - origin.x;
    visibleY = box.y - origin.y;
    floating.value = {
      ...original,
      x: visibleX,
      y: visibleY,
    };
  }

  // 指针拖动和松手落位共用短过渡，避免最后一帧切回模式切换的长过渡。
  reordering.value = !edge;
  target.setPointerCapture(event.pointerId);
  gesture = {
    edge,
    mode: props.mode,
    pointerId: event.pointerId,
    target,
    clientX: event.clientX,
    clientY: event.clientY,
    scrollY: window.scrollY,
    original,
    visibleX,
    visibleY,
    layout,
    slots,
    slot,
    maxDragY,
  };
  active.value = id;
  raised.value = id;
  document.documentElement.classList.add("card-gesture");
}
function move(event: PointerEvent) {
  if (!gesture || gesture.pointerId !== event.pointerId) return;
  pending = event;
  // 每个屏幕帧最多更新一次矩形，避免高频指针事件重复触发布局。
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  if (!gesture || !pending) return;
  // 从抓起时的位置计算当前位移，同时补偿手势中的页面滚动。
  const event = pending;
  pending = null;
  const { original, edge, layout, visibleX, visibleY } = gesture;
  const dx = event.clientX - gesture.clientX;
  const dy = event.clientY - gesture.clientY + window.scrollY - gesture.scrollY;
  const card = {
    ...original,
  };

  // 活动卡跟手，拖到底部时限制在最下方落点附近，避免把页面撑出空白。
  if (!edge) {
    card.x = Math.max(0, Math.min(width.value - card.width, visibleX + dx));
    card.y = Math.max(0, Math.min(gesture.maxDragY, visibleY + dy));
    floating.value = card;

    // 其余卡片只在落点改变时让位和收紧。轮廓和最终保存使用同一份排列。
    const slot = nearestSlot(gesture.slots, gesture.slot, card);
    dropTarget.value = slot.card;
    if (slot !== gesture.slot) {
      gesture.slot = slot;
      cards.value = slot.layout;
    }
    return;
  }
  // 八个方向共用相同边界约束，缩放时左上角与指针同步，图像通过容器尺寸适配。
  const minWidth = Math.min(width.value, card.id === "image" ? 350 : 270);
  if (edge.includes("e"))
    card.width = Math.max(
      minWidth,
      Math.min(width.value - original.x, original.width + dx),
    );
  if (edge.includes("s"))
    card.height = Math.max(minimum(card), original.height + dy);
  if (edge.includes("w")) {
    card.x = Math.max(
      0,
      Math.min(original.x + original.width - minWidth, original.x + dx),
    );
    card.width = original.x + original.width - card.x;
  }
  if (edge.includes("n")) {
    card.y = Math.max(
      0,
      Math.min(original.y + original.height - minimum(card), original.y + dy),
    );
    card.height = original.y + original.height - card.y;
  }
  card.height = Math.max(minimum(card), card.height);

  // 缩放期间只更新当前卡及其绘图区，松手后再为新尺寸整理位置。
  cards.value = layout.map((item) => (item.id === card.id ? card : item));
}
function finish(commit = true) {
  if (!gesture) return;

  // 先处理最后一个已排队的指针位置，避免在同一帧松手时漏掉这次移动。
  if (frame) cancelAnimationFrame(frame);
  const current = gesture;
  if (commit) flush();
  frame = 0;
  pending = null;

  // 先清空手势再释放指针，避免随后的 lostpointercapture 重复结束。
  gesture = null;
  active.value = null;
  floating.value = undefined;
  dropTarget.value = undefined;
  const captured = current.target.hasPointerCapture(current.pointerId);
  if (captured) current.target.releasePointerCapture(current.pointerId);
  document.documentElement.classList.remove("card-gesture");

  // 指针取消时还原整组卡片。正常松手收回浮动卡，使用轮廓预览的排列。
  if (!commit) {
    cards.value = current.layout;
    return;
  }
  if (current.edge) {
    cards.value = compact(cards.value, width.value);
  }
  remember(current.mode);
}
function endPointer(event: PointerEvent) {
  // 只有当前指针的正常松手才确认此手势。
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  finish(event.type === "pointerup");
}
function keyboard(event: KeyboardEvent, card: Rectangle) {
  // 指针手势期间的临时布局由该手势独占，避免键盘修改随后被快照覆盖。
  if (gesture) return;
  const steps: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = steps[event.key];
  if (!delta) return;
  event.preventDefault();
  // Shift 加方向键调整宽高，使用和指针缩放相同的收紧规则。
  const [horizontal, vertical] = delta;
  if (event.shiftKey) {
    reordering.value = false;
    card.width = Math.max(
      Math.min(card.id === "image" ? 350 : 270, width.value),
      Math.min(width.value - card.x, card.width + horizontal * cardGap),
    );
    card.height = Math.max(minimum(card), card.height + vertical * cardGap);
    cards.value = compact(cards.value, width.value);
  } else {
    // 方向键跳到指定方向的相邻落点，优先保持原来的行或列。
    const slots = dropSlots(cards.value, card, width.value);
    let best: DropSlot | undefined;
    let distance = Infinity;
    for (const slot of slots) {
      const dx = slot.card.x - card.x;
      const dy = slot.card.y - card.y;
      const forward = dx * horizontal + dy * vertical;
      if (forward <= 0) continue;
      const across = Math.abs(dx * vertical + dy * horizontal);
      const nextDistance = forward + 3 * across;
      if (nextDistance >= distance) continue;
      best = slot;
      distance = nextDistance;
    }
    if (!best) return;
    reordering.value = true;
    cards.value = best.layout;
  }
  remember();
}
watch(
  () => props.mode,
  () => {
    finish();
    restore();
  },
);
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const nextWidth = Math.round(entry.contentRect.width);
    if (nextWidth === width.value) return;
    // 初次挂载恢复排列；窗口宽度变化时按比例适配，跨越单列边界时重新排版。
    // 原生窗口缩放直接适配可用宽度；不把旧宽度的过渡动画带到较窄窗口外。
    adapting.value = true;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      adapting.value = false;
    }, 100);
    const previousWidth = width.value;
    const initial = previousWidth === 0;
    const wasSingleColumn = previousWidth < singleColumnWidth;
    const isSingleColumn = nextWidth < singleColumnWidth;
    const changedColumns = wasSingleColumn !== isSingleColumn;
    finish();
    reordering.value = false;
    width.value = nextWidth;
    if (initial) {
      restore();
    } else if (changedColumns) {
      cards.value = defaults();
    } else {
      const adapted = cards.value.map((card) => fitWidth(card, previousWidth));
      cards.value = compact(adapted, width.value);
    }
  });
  observer.observe(surface.value!);
});
onBeforeUnmount(() => {
  finish();
  observer?.disconnect();
  clearTimeout(resizeTimer);
  if (frame) cancelAnimationFrame(frame);
});
defineExpose({
  reset,
});
</script>

<template>
  <div
    ref="surface"
    class="card-workspace"
    :style="{
      height: `${height}px`,
    }"
    :class="{
      'is-interacting': active !== null,
      'is-reordering': reordering,
      'is-adapting': adapting,
    }"
    :data-mode="mode"
  >
    <div
      v-if="dropTarget"
      class="card-drop-target"
      :style="cardStyle(dropTarget)"
      aria-hidden="true"
    />
    <article
      v-for="card in displayedCards"
      :key="card.id"
      class="workspace-card"
      :class="{
        'is-active': active === card.id,
        'is-raised': raised === card.id,
      }"
      :data-card="card.id"
      :style="cardStyle(card)"
    >
      <slot :name="card.id" />
      <button
        class="card-grip"
        :aria-label="t('cards.move', { name: t(labels[card.id]) })"
        :title="t('cards.dragHint')"
        @pointerdown.prevent="begin($event, card.id)"
        @pointermove="move"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @lostpointercapture="endPointer"
        @keydown="keyboard($event, card)"
      >
        <svg viewBox="0 0 16 24" width="12" height="20" aria-hidden="true">
          <path
            d="M5 6h.01 M11 6h.01 M5 12h.01 M11 12h.01 M5 18h.01 M11 18h.01"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <div
        v-for="edge in edges"
        :key="edge"
        class="card-resize"
        :class="`resize-${edge}`"
        :data-edge="edge"
        aria-hidden="true"
        @pointerdown.prevent="begin($event, card.id, edge)"
        @pointermove="move"
        @pointerup="endPointer"
        @pointercancel="endPointer"
        @lostpointercapture="endPointer"
      />
    </article>
  </div>
</template>

<style scoped>
.card-workspace {
  position: relative;
  width: 100%;
  transition: height 320ms ease;
}
.card-workspace.is-reordering {
  /* 松手时画布与卡片同时收紧，避免卡片落位后才缓慢收掉空白。 */
  transition-duration: 150ms;
}
.card-workspace.is-interacting {
  transition: none;
}
.card-drop-target {
  position: absolute;
  top: 0;
  left: 0;
  border: 1px dashed var(--accent);
  border-radius: 16px;
  background: var(--accent-soft);
  pointer-events: none;
}
.workspace-card {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 0;
  /* 隔离卡片内部布局并提前准备合成层，拖动开始时不用临时提升整张卡片。 */
  contain: layout style;
  will-change: transform;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 3px 12px #10182005;
  transition:
    transform var(--card-move-time, 360ms)
      var(--card-move-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    width 360ms cubic-bezier(0.22, 1, 0.36, 1),
    height 360ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 180ms;
}
.card-workspace.is-reordering .workspace-card {
  /* 同一个短过渡贯穿补位和落位，尺寸的过渡仍留给缩放与切换模式。 */
  --card-move-time: 150ms;
  --card-move-easing: cubic-bezier(0.2, 0.75, 0.35, 1);
}
.card-workspace.is-adapting .workspace-card {
  transition: none;
}
.workspace-card.is-raised {
  z-index: 2;
}
.workspace-card.is-active {
  z-index: 5;
  transition: box-shadow 180ms;
  box-shadow: 0 12px 24px #10182024;
  outline: 1px solid var(--accent);
}
.workspace-card :deep(> .panel) {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  border: 0;
  border-radius: inherit;
  box-shadow: none;
  overflow: hidden;
}
.card-grip {
  position: absolute;
  right: 8px;
  top: 13px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: grab;
  touch-action: none;
}
.card-grip:hover,
.card-grip:focus-visible {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.is-active .card-grip {
  cursor: grabbing;
}
.card-resize {
  position: absolute;
  z-index: 6;
  touch-action: none;
}
.resize-n,
.resize-s {
  left: 15px;
  right: 15px;
  height: 7px;
  cursor: ns-resize;
}
.resize-n {
  top: -3px;
}
.resize-s {
  bottom: -3px;
}
.resize-e,
.resize-w {
  top: 15px;
  bottom: 15px;
  width: 7px;
  cursor: ew-resize;
}
.resize-e {
  right: -3px;
}
.resize-w {
  left: -3px;
}
.resize-ne,
.resize-se,
.resize-sw,
.resize-nw {
  width: 17px;
  height: 17px;
}
.resize-ne {
  right: -3px;
  top: -3px;
  cursor: nesw-resize;
}
.resize-se {
  right: -3px;
  bottom: -3px;
  cursor: nwse-resize;
}
.resize-sw {
  left: -3px;
  bottom: -3px;
  cursor: nesw-resize;
}
.resize-nw {
  left: -3px;
  top: -3px;
  cursor: nwse-resize;
}
.resize-se::after {
  content: "";
  position: absolute;
  right: 7px;
  bottom: 7px;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  opacity: 0.65;
  border-bottom-right-radius: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .workspace-card,
  .card-workspace {
    transition: none;
  }
}
:global([data-reduced-motion="true"]) .workspace-card,
:global([data-reduced-motion="true"]) .card-workspace {
  transition: none;
}
</style>
