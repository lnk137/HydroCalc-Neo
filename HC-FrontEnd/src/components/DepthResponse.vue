<script setup lang="ts">
import { computed, ref } from "vue";
import { usePlotSize } from "../usePlotSize";
import { t } from "../i18n";
import { format } from "../state";
import { wettingProfile } from "../wetting";

const props = defineProps<{
  counts: number[];
  width: number;
  height: number;
  depth: number;
  pins: number[];
}>();
const emit = defineEmits<{
  pin: [];
  select: [depth: number];
  remove: [depth: number];
}>();
const drawing = ref<SVGSVGElement>();
const size = usePlotSize(drawing);
const plotRight = computed(() => size.width.value - 24);
const plotBottom = computed(() => size.height.value - 38);
const plotWidth = computed(() => plotRight.value - 48);
const plotHeight = computed(() => plotBottom.value - 20);
// 响应曲线与主图复用原始计数，主题和容器沿用原来的曲线卡。
const measure = computed(() =>
  wettingProfile(props.counts, props.width, props.height),
);
const loss = computed(() => measure.value(props.depth).rdpr_percent);
const points = computed(() => {
  if (!props.counts.length) return "";
  const positions: string[] = [];
  for (let index = 0; index <= props.counts.length; index++) {
    const depth = (index / props.counts.length) * props.height;
    const value = measure.value(depth).rdpr_percent;
    if (value !== null)
      positions.push(
        `${48 + (depth / props.height) * plotWidth.value},${plotBottom.value - (value / 100) * plotHeight.value}`,
      );
  }
  return positions.join(" ");
});
</script>

<template>
  <section class="panel chart-panel response-panel">
    <div class="panel-heading">
      <h2>{{ t("explorer.responseTitle") }}</h2>
      <button
        class="text-button"
        :disabled="!counts.length || depth > height"
        @click="emit('pin')"
      >
        {{ t("explorer.pin") }}
      </button>
    </div>
    <svg
      ref="drawing"
      class="depth-chart"
      :viewBox="`0 0 ${size.width.value} ${size.height.value}`"
      role="img"
      :aria-label="t('explorer.response')"
    >
      <g v-for="tick in [0, 50, 100]" :key="tick">
        <line
          x1="48"
          :x2="plotRight"
          :y1="plotBottom - (tick / 100) * plotHeight"
          :y2="plotBottom - (tick / 100) * plotHeight"
          class="chart-grid"
        />
        <text
          x="38"
          :y="plotBottom + 4 - (tick / 100) * plotHeight"
          text-anchor="end"
        >
          {{ tick }}%
        </text>
      </g>
      <g v-for="tick in [0, 0.25, 0.5, 0.75, 1]" :key="tick">
        <text
          :x="48 + tick * plotWidth"
          :y="plotBottom + 18"
          text-anchor="middle"
        >
          {{ format(tick * height) }}
        </text>
      </g>
      <text :x="plotRight" :y="plotBottom + 34" text-anchor="end">
        {{ t("settings.plannedWettingDepth") }} / cm
      </text>
      <polyline :points="points" class="response-line" />
      <line
        v-for="pin in pins"
        :key="pin"
        :x1="48 + (pin / height) * plotWidth"
        :x2="48 + (pin / height) * plotWidth"
        y1="20"
        :y2="plotBottom"
        class="chart-grid"
      />
      <g v-if="loss !== null">
        <line
          :x1="48 + (depth / height) * plotWidth"
          :x2="48 + (depth / height) * plotWidth"
          y1="20"
          :y2="plotBottom"
          class="response-marker"
        />
        <circle
          :cx="48 + (depth / height) * plotWidth"
          :cy="plotBottom - (loss / 100) * plotHeight"
          r="4"
          class="response-point"
        />
      </g>
    </svg>
    <div v-if="pins.length" class="response-comparisons">
      <span v-for="pin in pins" :key="pin">
        <button class="text-button" @click="emit('select', pin)">
          {{ format(pin) }} cm
          <strong>{{ format(measure(pin).rdpr_percent, 4) }}%</strong>
        </button>
        <button
          class="icon-button"
          :aria-label="t('explorer.removePin', { depth: pin })"
          @click="emit('remove', pin)"
        >
          ×
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.response-line {
  fill: none;
  stroke: var(--danger);
  stroke-width: 2;
  stroke-linejoin: round;
}
.response-marker {
  stroke: var(--danger);
  stroke-dasharray: 3 4;
  stroke-width: 1;
  opacity: 0.6;
}
.response-point {
  fill: var(--danger);
}
.response-comparisons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 15px;
  padding: 0 20px 16px;
}
.response-comparisons > span {
  display: flex;
  align-items: center;
  gap: 2px;
}
.response-comparisons strong {
  margin-left: 7px;
  font-weight: 500;
  color: var(--danger);
}
.response-comparisons .icon-button {
  width: 24px;
  height: 24px;
}
.response-panel .panel-heading {
  gap: 8px;
}
.response-panel .panel-heading button {
  font-size: 11px;
}
</style>
