<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type { Analysis } from "../types";
import { format, imageUrl, report } from "../state";
import { t } from "../i18n";
import { wettingProfile } from "../wetting";

const props = defineProps<{
  record: Analysis;
  processing: boolean;
  preservePreview: boolean;
}>();
const emit = defineEmits<{
  commitDepth: [depth: number];
}>();
const drawing = ref<SVGSVGElement>();
// 卡片尺寸变化只更新绘图几何，掩膜不重新解码，拖动深度不重新计算整条曲线。
const exporting = ref(false);
const plotHeight = ref(430);
const drawingScale = ref(1);
const plotSpan = computed(() => (exporting.value ? 430 : plotHeight.value));
const plotBottom = computed(() => 75 + plotSpan.value);
let observer: ResizeObserver;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    // 记录 SVG 单位到实际像素的比例，悬停读数在窄窗中也保持同样大小。
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width <= 0 || height <= 0) return;
    const ratio = height / width;
    const span = Math.max(240, 1000 * ratio - 65);
    plotHeight.value = span;
    drawingScale.value = Math.min(width / 1000, height / (span + 65));
  });
  observer.observe(surface.value!);
});
onBeforeUnmount(() => observer?.disconnect());
const depth = ref(40);
const hovered = ref<number | null>(null);
let drag: { pointerId: number; originalDepth: number } | null = null;
let editingWithKeys = false;
const pins = ref<number[]>([]);
function pinDepth() {
  // 固定深度仅用于当前图的比较，每个标记由同一份像素计数计算。
  if (!pins.value.includes(depth.value)) pins.value.push(depth.value);
}
const greenImage = ref("");
const redImage = ref("");
const surface = ref<HTMLDivElement>();
const height = computed(() => props.record.settings!.soil_height_cm);
const rows = computed(() => props.record.profile || []);
const counts = ref<number[]>([]);
const measure = computed(() =>
  wettingProfile(
    counts.value,
    props.record.settings!.resolution_width,
    height.value,
  ),
);
const values = computed(() => measure.value(depth.value));

const boundary = computed(
  () => 75 + Math.min(1, depth.value / height.value) * plotSpan.value,
);
const metrics = computed(() => [
  {
    name: t("metrics.rdpr_percent"),
    value: values.value.rdpr_percent,
  },
  {
    name: t("metrics.ea_percent"),
    value: values.value.ea_percent,
  },
  {
    name: t("metrics.es_percent"),
    value: values.value.es_percent,
  },
]);
// 每行绘成水平阶梯，与统计采用的行内均匀假设保持一致。
const profilePoints = computed(() => {
  const points: string[] = [];
  rows.value.forEach((row, index) => {
    const x = 720 + row.ratio * 2;
    const top = 75 + (index / rows.value.length) * plotSpan.value;
    const bottom = 75 + ((index + 1) / rows.value.length) * plotSpan.value;
    points.push(`${x},${top}`, `${x},${bottom}`);
  });
  return points.join(" ");
});
const responsePoints = computed(() => {
  if (counts.value.length === 0) return "";
  // 累积曲线保留全部行边界，使窄通道引起的变化也可复核。
  const points: string[] = [];
  for (let index = 0; index <= counts.value.length; index++) {
    const physical = (index / counts.value.length) * height.value;
    const loss = measure.value(physical).rdpr_percent;
    if (loss !== null)
      points.push(
        `${70 + (physical / height.value) * 850},${680 - loss * 0.6}`,
      );
  }
  return points.join(" ");
});
const inspected = computed(() => {
  // 深度、灰线和曲线标记共用当前数据行的中心位置。
  const index = hovered.value;
  if (index === null) return null;
  const row = rows.value[index];
  if (!row) return null;
  const y = 75 + ((index + 0.5) / rows.value.length) * plotSpan.value;

  // 将提示的实际像素换算成 SVG 单位，让宽度和字号随窗口缩放保持可读。
  const scale = drawingScale.value;
  const labelWidth = 78 / scale;
  const labelHeight = 37 / scale;
  const labelGap = 4 / scale;

  // 读数放在两图之间，必要时翻到灰线的另一侧，避开红色边界标签。
  const above = y - labelHeight - labelGap;
  const below = y + labelGap;
  const redLabelTop = boundary.value - 25;
  const redLineBottom = boundary.value + labelGap;
  const beforeRed = redLabelTop - labelHeight - labelGap;
  const candidates = [above, below, beforeRed, redLineBottom];
  const labelY = candidates.find((top) => {
    const bottom = top + labelHeight;
    const inside = top >= 75 && bottom <= plotBottom.value;
    const clearOfBoundary =
      depth.value > height.value ||
      bottom <= redLabelTop - labelGap ||
      top >= redLineBottom;
    return inside && clearOfBoundary;
  });

  const maxLabelY = plotBottom.value - labelHeight;
  return {
    ...row,
    x: 720 + row.ratio * 2,
    y,
    labelWidth,
    labelHeight,
    scale,
    labelY: labelY ?? Math.max(75, Math.min(above, maxLabelY)),
  };
});
const clipRoot = computed(() => "explorer-root-" + props.record.id);
const clipDeep = computed(() => "explorer-deep-" + props.record.id);
const ready = computed(
  () => greenImage.value !== "" && counts.value.length > 0,
);

watch(
  () => props.record.id,
  async () => {
    // 同一图的自动分析保留画面和对比点，直到新掩膜解码完毕；打开其他图则清空旧数据。
    depth.value = props.record.root_zone!.root_depth_cm;
    if (!props.preservePreview) {
      greenImage.value = "";
      pins.value = [];
      counts.value = [];
      redImage.value = "";
    }
    hovered.value = null;
    drag = null;
    editingWithKeys = false;
    const id = props.record.id;
    try {
      const image = new Image();
      image.src = imageUrl(props.record, "mask");
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const perRow = new Array<number>(canvas.height).fill(0);
      // 同一张掩膜生成两种纯色底图，拖动时通过裁切切换颜色。
      const original = new Uint8ClampedArray(pixels.data);
      const colors = [
        [37, 141, 132],
        [229, 107, 99],
      ];
      const images: string[] = [];
      colors.forEach((color, colorIndex) => {
        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const offset = (y * canvas.width + x) * 4;
            const stained = original[offset]! < 128;
            if (stained && colorIndex === 0) perRow[y]! += 1;
            pixels.data[offset] = stained ? color[0]! : 255;
            pixels.data[offset + 1] = stained ? color[1]! : 255;
            pixels.data[offset + 2] = stained ? color[2]! : 255;
          }
        }
        context.putImageData(pixels, 0, 0);
        images.push(canvas.toDataURL("image/png"));
      });
      // 异步解码结束时核对记录，快速切换图片不会覆盖当前视图。
      if (props.record.id !== id) return;
      counts.value = perRow;
      greenImage.value = images[0]!;
      redImage.value = images[1]!;
    } catch (error) {
      if (props.record.id === id) report(error);
    }
  },
  {
    immediate: true,
  },
);

function setDepth(value: number) {
  // 无效编辑保留当前有效预览，允许精确到非整数像素层。
  if (!Number.isFinite(value)) return;
  depth.value = Math.max(0.01, Math.min(height.value, value));
}
function coordinates(event: PointerEvent) {
  // 使用 SVG 坐标变换处理窗口缩放和留白，确保手柄跟随真实指针位置。
  const matrix = drawing.value!.getScreenCTM()!;
  const point = new DOMPoint(event.clientX, event.clientY);
  return point.matrixTransform(matrix.inverse());
}
function move(event: PointerEvent) {
  const point = coordinates(event);
  if (drag?.pointerId === event.pointerId) {
    const physical = ((point.y - 75) / plotSpan.value) * height.value;
    setDepth(Math.round(physical * 100) / 100);
    return;
  }
  const within =
    point.y >= 75 &&
    point.y <= plotBottom.value &&
    point.x >= 70 &&
    point.x <= 920;
  hovered.value = within
    ? Math.min(
        rows.value.length - 1,
        Math.floor(((point.y - 75) / plotSpan.value) * rows.value.length),
      )
    : null;
}
function start(event: PointerEvent) {
  // 按下时记住原深度，拖动只预览，取消指针可恢复原数值。
  if (props.processing || event.button !== 0 || drag) return;
  drag = {
    pointerId: event.pointerId,
    originalDepth: depth.value,
  };
  hovered.value = null;
  drawing.value!.setPointerCapture(event.pointerId);
}
function stop(event: PointerEvent) {
  // 只在正常松开时提交一次；意外失去指针捕获不写入历史。
  if (drag?.pointerId !== event.pointerId) return;
  const originalDepth = drag.originalDepth;
  drag = null;
  if (event.type === "pointerup") {
    emit("commitDepth", depth.value);
  } else {
    setDepth(originalDepth);
  }
}
function previewWithKey(value: number) {
  // 长按期间保持预览，松键后才提交，避免为按键重复建立历史。
  if (props.processing || drag) return;
  editingWithKeys = true;
  setDepth(value);
}
function commitKeyDepth() {
  if (!editingWithKeys) return;
  editingWithKeys = false;
  emit("commitDepth", depth.value);
}
async function exportFigure() {
  try {
    // 克隆当前图版并嵌入已着色图片，清理悬停提示后以双倍分辨率导出。
    exporting.value = true;
    await nextTick();
    const clone = drawing.value!.cloneNode(true) as SVGSVGElement;
    clone.querySelectorAll("[data-hover]").forEach((node) => node.remove());
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("viewBox", "0 0 1000 760");
    clone.removeAttribute("class");
    clone.setAttribute(
      "style",
      "font-family:Arial,'Microsoft YaHei',sans-serif",
    );
    const serialized = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([serialized], {
      type: "image/svg+xml",
    });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 2000;
      canvas.height = 1520;
      canvas.getContext("2d")!.drawImage(image, 0, 0, 2000, 1520);
      const data = canvas.toDataURL("image/png");
      if (window.hydrocalc?.exportFigure) {
        await window.hydrocalc.exportFigure(data);
      } else {
        const link = document.createElement("a");
        link.href = data;
        link.download = "hydrocalc-wetting-figure.png";
        link.click();
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (error) {
    report(error);
  } finally {
    exporting.value = false;
  }
}
// 深度、指标和导出由分析页的既有入口统一管理，切换图像视图时保留预览。
function removePin(value: number) {
  pins.value = pins.value.filter((pin) => pin !== value);
}
async function zoom() {
  await surface.value!.requestFullscreen();
}
defineExpose({
  depth,
  values,
  counts,
  pins,
  ready,
  setDepth,
  pinDepth,
  removePin,
  exportFigure,
  zoom,
});
</script>

<template>
  <div ref="surface" class="wetting-explorer">
    <button
      class="button explorer-fullscreen-close"
      @click="surface?.ownerDocument.exitFullscreen()"
    >
      {{ t("image.closeZoom") }}
    </button>
    <span v-if="!ready" class="spinner"></span>
    <svg
      v-show="ready"
      ref="drawing"
      class="explorer-drawing"
      :viewBox="`0 40 1000 ${plotSpan + 65}`"
      role="img"
      :aria-label="t('explorer.title')"
      @pointermove="move"
      @pointerup="stop"
      @pointercancel="stop"
      @lostpointercapture="stop"
      @pointerleave="hovered = null"
      style="font-family: inherit; touch-action: pan-x"
    >
      <rect class="figure-only" width="1000" height="760" fill="#fff" />
      <text class="figure-only" x="70" y="30" font-size="17" fill="#303238">
        {{ record.name }}
      </text>
      <text x="70" y="56" font-size="12" fill="#777a82">
        {{ t("explorer.depth") }} / cm
      </text>
      <text x="720" y="56" font-size="12" fill="#777a82">DC / %</text>
      <defs>
        <clipPath :id="clipRoot">
          <rect
            x="70"
            y="75"
            width="850"
            :height="Math.max(0, boundary - 75)"
          />
        </clipPath>
        <clipPath :id="clipDeep">
          <rect
            x="70"
            :y="boundary"
            width="850"
            :height="plotBottom - boundary"
          />
        </clipPath>
      </defs>
      <g v-for="tick in [0, 0.25, 0.5, 0.75, 1]" :key="tick">
        <line
          x1="70"
          x2="920"
          :y1="75 + tick * plotSpan"
          :y2="75 + tick * plotSpan"
          stroke="#e5e7e8"
          stroke-dasharray="3 4"
        />
        <text
          x="53"
          :y="79 + tick * plotSpan"
          text-anchor="end"
          font-size="12"
          fill="#777a82"
        >
          {{ format(tick * height) }}
        </text>
      </g>
      <g v-for="tick in [0, 50, 100]" :key="tick">
        <text
          :x="720 + tick * 2"
          y="68"
          text-anchor="middle"
          font-size="11"
          fill="#777a82"
        >
          {{ tick }}
        </text>
      </g>
      <g :clip-path="`url(#${clipRoot})`">
        <image
          :href="greenImage"
          x="70"
          y="75"
          width="560"
          :height="plotSpan"
          preserveAspectRatio="none"
        />
        <polygon
          :points="`720,75 ${profilePoints} 720,${plotBottom}`"
          fill="#258d84"
          fill-opacity=".2"
        />
        <polyline
          :points="profilePoints"
          fill="none"
          stroke="#258d84"
          stroke-width="2"
        />
      </g>
      <g :clip-path="`url(#${clipDeep})`">
        <image
          :href="redImage"
          x="70"
          y="75"
          width="560"
          :height="plotSpan"
          preserveAspectRatio="none"
        />
        <polygon
          :points="`720,75 ${profilePoints} 720,${plotBottom}`"
          fill="#e56b63"
          fill-opacity=".3"
        />
        <polyline
          :points="profilePoints"
          fill="none"
          stroke="#e56b63"
          stroke-width="2"
        />
      </g>
      <rect
        x="70"
        y="75"
        width="560"
        :height="plotSpan"
        fill="none"
        stroke="#dde1e0"
      />
      <line x1="720" x2="720" y1="75" :y2="plotBottom" stroke="#dde1e0" />
      <g
        v-if="inspected"
        data-hover="true"
        pointer-events="none"
        class="explorer-inspection"
      >
        <line
          x1="70"
          x2="920"
          :y1="inspected.y"
          :y2="inspected.y"
          vector-effect="non-scaling-stroke"
        />
        <circle :cx="inspected.x" :cy="inspected.y" r="4" />
        <rect
          :x="675 - inspected.labelWidth / 2"
          :y="inspected.labelY"
          :width="inspected.labelWidth"
          :height="inspected.labelHeight"
          :rx="5 / inspected.scale"
        />
        <text
          x="675"
          :y="inspected.labelY + 15 / inspected.scale"
          text-anchor="middle"
          class="inspection-depth"
          :style="{ fontSize: 11.5 / inspected.scale + 'px' }"
        >
          {{ format(inspected.depth_cm) }} cm
        </text>
        <text
          x="675"
          :y="inspected.labelY + 29 / inspected.scale"
          text-anchor="middle"
          class="inspection-ratio"
          :style="{ fontSize: 10.5 / inspected.scale + 'px' }"
        >
          DC {{ format(inspected.ratio) }}%
        </text>
      </g>
      <g
        v-if="depth <= height"
        class="explorer-handle"
        role="slider"
        aria-orientation="vertical"
        :tabindex="processing ? -1 : 0"
        :aria-disabled="processing"
        :aria-label="t('settings.plannedWettingDepth')"
        aria-valuemin="0.01"
        :aria-valuemax="height"
        :aria-valuenow="depth"
        @pointerdown.prevent="start"
        @keydown.up.prevent="previewWithKey(depth - 0.1)"
        @keydown.down.prevent="previewWithKey(depth + 0.1)"
        @keydown.home.prevent="previewWithKey(0.01)"
        @keydown.end.prevent="previewWithKey(height)"
        @keyup.up="commitKeyDepth"
        @keyup.down="commitKeyDepth"
        @keyup.home="commitKeyDepth"
        @keyup.end="commitKeyDepth"
        @blur="commitKeyDepth"
      >
        <line
          x1="62"
          x2="936"
          :y1="boundary"
          :y2="boundary"
          stroke="transparent"
          stroke-width="24"
        />
        <line
          x1="70"
          x2="920"
          :y1="boundary"
          :y2="boundary"
          stroke="#e56b63"
          stroke-width="1.5"
          stroke-dasharray="7 5"
        />
        <circle
          cx="70"
          :cy="boundary"
          r="7"
          fill="#fff"
          stroke="#e56b63"
          stroke-width="2"
        />
        <circle
          cx="920"
          :cy="boundary"
          r="7"
          fill="#fff"
          stroke="#e56b63"
          stroke-width="2"
        />
        <rect
          x="636"
          :y="boundary - 25"
          width="78"
          height="21"
          rx="4"
          fill="#fff"
        />
        <text
          x="675"
          :y="boundary - 10"
          text-anchor="middle"
          font-size="12"
          fill="#c9534d"
        >
          Zr {{ format(depth) }} cm
        </text>
      </g>
      <g class="figure-only">
        <circle cx="70" cy="520" r="3" fill="#258d84" />
        <text x="80" y="524" font-size="11" fill="#777a82">
          {{ t("image.retained") }}
        </text>
        <circle cx="255" cy="520" r="3" fill="#e56b63" />
        <text x="265" y="524" font-size="11" fill="#777a82">
          {{ t("image.leakage") }}
        </text>
        <g v-for="(metric, index) in metrics" :key="metric.name">
          <text :x="70 + index * 285" y="538" font-size="12" fill="#777a82">
            {{ metric.name }}
          </text>
          <text
            :x="70 + index * 285"
            y="568"
            font-size="25"
            :fill="index === 0 ? '#c9534d' : '#303238'"
          >
            {{ ready ? format(metric.value, 4) : "—" }} %
          </text>
        </g>
        <text x="70" y="609" font-size="12" fill="#777a82">
          {{ t("explorer.response") }}
        </text>
        <line x1="70" x2="920" y1="680" y2="680" stroke="#dde1e0" />
        <polyline
          :points="responsePoints"
          fill="none"
          stroke="#e56b63"
          stroke-width="2"
        />
        <circle
          v-if="values.rdpr_percent !== null"
          :cx="70 + (depth / height) * 850"
          :cy="680 - values.rdpr_percent * 0.6"
          r="5"
          fill="#e56b63"
        />
        <g v-for="tick in [0, 0.25, 0.5, 0.75, 1]" :key="tick">
          <text
            :x="70 + tick * 850"
            y="701"
            text-anchor="middle"
            font-size="11"
            fill="#777a82"
          >
            {{ format(tick * height) }} cm
          </text>
        </g>
        <text x="925" y="624" font-size="10" fill="#777a82">100%</text>
        <text x="925" y="683" font-size="10" fill="#777a82">0%</text>
        <g v-for="pin in pins" :key="pin">
          <line
            :x1="70 + (pin / height) * 850"
            :x2="70 + (pin / height) * 850"
            y1="620"
            y2="680"
            stroke="#9ca7a3"
            stroke-dasharray="3 3"
          />
          <text
            :x="70 + (pin / height) * 850"
            y="724"
            text-anchor="middle"
            font-size="11"
            fill="#777a82"
          >
            {{ format(pin) }} cm / {{ format(measure(pin).rdpr_percent, 2) }}%
          </text>
        </g>
        <text x="70" y="741" font-size="11" fill="#777a82">
          A_root {{ format(values.a_root, 6) }} / A_tot
          {{ format(values.a_tot, 6) }}　{{ record.settings?.soil_width_cm }} ×
          {{ height }} cm　{{ record.settings?.resolution_width }} ×
          {{ record.settings?.resolution_height }} px
        </text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.wetting-explorer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: grid;
  place-items: center;
}
.explorer-drawing {
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.figure-only {
  display: none;
}
.explorer-drawing text {
  fill: var(--secondary);
  font-size: 15px;
}
.explorer-drawing [fill="#303238"] {
  fill: var(--text);
}
.explorer-drawing [stroke="#e5e7e8"],
.explorer-drawing [stroke="#dde1e0"] {
  stroke: var(--line);
}
.explorer-inspection line {
  stroke: var(--muted);
  stroke-opacity: 0.6;
}
.explorer-inspection circle {
  fill: var(--surface);
  stroke: var(--secondary);
  stroke-width: 1.5;
}
.explorer-inspection rect {
  fill: var(--surface);
  stroke: var(--line);
}
.explorer-drawing .inspection-depth {
  fill: var(--text);
  font-weight: 600;
}
.explorer-handle {
  cursor: ns-resize;
  touch-action: none;
  outline: none;
}
.explorer-handle:focus circle {
  stroke-width: 4;
}
.explorer-handle[aria-disabled="true"] {
  cursor: wait;
}
.explorer-fullscreen-close {
  display: none;
}
.wetting-explorer:fullscreen {
  background: var(--canvas);
  padding: 40px;
}
.wetting-explorer:fullscreen .explorer-fullscreen-close {
  display: block;
  position: absolute;
  top: 15px;
  right: 20px;
  z-index: 2;
}
</style>
