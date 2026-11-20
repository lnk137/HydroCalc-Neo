<script setup lang="ts">
import { usePlotSize } from "../usePlotSize";
import { t } from "../i18n";
import { computed, ref } from "vue";
import type { Analysis } from "../types";
import { format } from "../state";

const props = defineProps<{
  record: Analysis;
  plannedDepth?: number;
}>();
const svg = ref<SVGSVGElement>();
const hover = ref<number | null>(null);
const size = usePlotSize(svg);
const plotRight = computed(() => size.width.value - 28);
const plotBottom = computed(() => size.height.value - 32);
const plotWidth = computed(() => plotRight.value - 48);
const plotHeight = computed(() => plotBottom.value - 24);
const depth = computed(() => props.record.settings?.soil_height_cm || 50);
// 全部深度行参与绘图，较窄的深层染色通道也能在曲线中呈现。
const samples = computed(() => props.record.profile || []);
// 使用历史快照中的湿润层深度定位分色边界，避免当前设置改动影响旧结果。
const wettingDepth = computed(
  () => props.plannedDepth ?? props.record.root_zone?.root_depth_cm ?? 40,
);
const hasWetting = computed(
  () => props.record.root_zone?.total_scope === "full_profile",
);
const boundaryY = computed(() => {
  const fraction = Math.min(1, wettingDepth.value / depth.value);
  return 24 + fraction * plotHeight.value;
});
const retainedClip = computed(() => "retained-" + props.record.id);
const leakageClip = computed(() => "leakage-" + props.record.id);
const points = computed(() =>
  samples.value
    .map(
      (row) =>
        `${48 + (row.ratio / 100) * plotWidth.value},${24 + (row.depth_cm / depth.value) * plotHeight.value}`,
    )
    .join(" "),
);
const inspected = computed(() => {
  if (hover.value === null) return null;
  const rows = props.record.profile || [];
  return rows[
    Math.min(
      rows.length - 1,
      Math.max(0, Math.round(hover.value * (rows.length - 1))),
    )
  ];
});
function inspect(event: MouseEvent) {
  // 根据 SVG 的实际渲染尺寸定位深度，缩放窗口后仍可检查对应的真实数据行。
  const matrix = svg.value?.getScreenCTM();
  if (!matrix) return;
  const pointer = new DOMPoint(event.clientX, event.clientY);
  const position = pointer.matrixTransform(matrix.inverse());
  hover.value = Math.max(0, Math.min(1, (position.y - 24) / plotHeight.value));
}
</script>

<template>
  <section class="panel chart-panel">
    <div class="panel-heading">
      <h2>{{ t("chart.title") }}</h2>
      <span class="chart-reading" v-if="inspected"
        >{{ format(inspected.depth_cm) }} cm /
        {{ format(inspected.ratio) }}%</span
      ><span v-else class="muted small">{{ t("chart.ratio") }}</span>
    </div>
    <svg
      ref="svg"
      class="depth-chart"
      :viewBox="`0 0 ${size.width.value} ${size.height.value}`"
      role="img"
      :aria-label="t('chart.description')"
      @mousemove="inspect"
      @mouseleave="hover = null"
    >
      <g v-for="tick in [0, 25, 50, 75, 100]" :key="tick">
        <line
          :x1="48 + (tick / 100) * plotWidth"
          y1="24"
          :x2="48 + (tick / 100) * plotWidth"
          :y2="plotBottom"
          class="chart-grid"
        />
        <text
          :x="48 + (tick / 100) * plotWidth"
          :y="plotBottom + 22"
          text-anchor="middle"
        >
          {{ tick }}
        </text>
      </g>
      <g v-for="tick in [0, 0.25, 0.5, 0.75, 1]" :key="tick">
        <line
          x1="48"
          :y1="24 + tick * plotHeight"
          :x2="plotRight"
          :y2="24 + tick * plotHeight"
          class="chart-grid"
        />
        <text x="34" :y="28 + tick * plotHeight" text-anchor="end">
          {{ format(tick * depth, 1) }}
        </text>
      </g>
      <text x="14" y="13">cm</text>
      <template v-if="hasWetting">
        <defs>
          <clipPath :id="retainedClip">
            <rect x="48" y="24" :width="plotWidth" :height="boundaryY - 24" />
          </clipPath>
          <clipPath :id="leakageClip">
            <rect
              x="48"
              :y="boundaryY"
              :width="plotWidth"
              :height="plotBottom - boundaryY"
            />
          </clipPath>
        </defs>
        <g :clip-path="`url(#${retainedClip})`">
          <polygon
            :points="`48,24 ${points} 48,${plotBottom}`"
            class="chart-fill wetting-retained"
          />
          <polyline :points="points" class="chart-line wetting-retained" />
        </g>
        <g :clip-path="`url(#${leakageClip})`">
          <polygon
            :points="`48,24 ${points} 48,${plotBottom}`"
            class="chart-fill wetting-leakage"
          />
          <polyline :points="points" class="chart-line wetting-leakage" />
        </g>
        <g v-if="wettingDepth <= depth">
          <line
            x1="48"
            :x2="plotRight"
            :y1="boundaryY"
            :y2="boundaryY"
            class="wetting-boundary"
          />
          <text
            :x="plotRight"
            :y="boundaryY - 5"
            text-anchor="end"
            class="wetting-depth-label"
          >
            Zr = {{ format(wettingDepth, 6) }} cm
          </text>
        </g>
      </template>
      <template v-else>
        <polygon
          :points="`48,24 ${points} 48,${plotBottom}`"
          class="chart-fill"
        />
        <polyline :points="points" class="chart-line" />
      </template>
      <line
        v-if="inspected"
        x1="48"
        :x2="plotRight"
        :y1="24 + (inspected.depth_cm / depth) * plotHeight"
        :y2="24 + (inspected.depth_cm / depth) * plotHeight"
        class="chart-crosshair"
      />
      <circle
        v-if="inspected"
        :cx="48 + (inspected.ratio / 100) * plotWidth"
        :cy="24 + (inspected.depth_cm / depth) * plotHeight"
        r="4"
        class="chart-point"
      />
    </svg>
  </section>
</template>
