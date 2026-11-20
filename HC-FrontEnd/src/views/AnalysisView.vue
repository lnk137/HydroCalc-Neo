<script setup lang="ts">
import { t } from "../i18n";
import { computed, ref, watch } from "vue";
import CardWorkspace from "../components/CardWorkspace.vue";
import Icon from "../components/Icon.vue";
import WettingExplorer from "../components/WettingExplorer.vue";
import DepthResponse from "../components/DepthResponse.vue";
import DepthChart from "../components/DepthChart.vue";
import BatchQueue from "../components/BatchQueue.vue";
import {
  analyzeAtDepth,
  analyzeFiles,
  busy,
  date,
  exportArtifact,
  format,
  imageUrl,
  report,
  state,
} from "../state";

const workspace = ref<InstanceType<typeof CardWorkspace>>();
const input = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const modal = ref<HTMLDialogElement>();
const view = ref("annotated");
const exportKind = ref("bundle");
const dragging = ref(false);
const blurred = ref(false);
const explorer = ref<InstanceType<typeof WettingExplorer>>();
const pendingDepth = ref<{ id: string; depth: number }>();
const automaticResult = ref<string>();
const record = computed(() => state.active);
// 按历史快照显示当时的算法，缺少新字段的旧结果仍可打开和导出。
const processingSettings = computed(
  () => record.value?.settings || state.settings,
);
const processingLabel = computed(() => {
  const settings = processingSettings.value;
  if (!settings?.denoise_method) return t("settings.blur");
  return t("denoise." + settings.denoise_method);
});
const processingDetails = computed(() => {
  const settings = processingSettings.value;
  if (!settings) return "—";
  if (record.value?.effective_method === "binary") return t("common.off");
  if (settings.denoise_enabled === undefined) {
    const kernel = settings.blur_kernel;
    return kernel ? `${kernel} × ${kernel}` : t("common.off");
  }
  if (!settings.denoise_enabled) return t("common.off");
  if (settings.denoise_method === "bilateral") {
    return `${settings.bilateral_diameter} px / σc ${settings.bilateral_sigma_color} / σs ${settings.bilateral_sigma_space}`;
  }
  if (settings.denoise_method === "median") {
    return `${settings.median_kernel} × ${settings.median_kernel}`;
  }
  return `h ${settings.nlm_h} / hc ${settings.nlm_h_color} / ${settings.nlm_template_window} × ${settings.nlm_search_window}`;
});
const canExplore = computed(
  () =>
    completed.value && record.value?.root_zone?.total_scope === "full_profile",
);
// 整个分析页共享当前边界，切换图片类型时指标和参数位置保持一致。
const liveDepth = computed(() => {
  const pending = pendingDepth.value;
  if (pending && pending.id === record.value?.id) return pending.depth;
  return explorer.value?.ready ? explorer.value.depth : savedDepth.value;
});
const applyingDepth = computed(() => {
  const pending = pendingDepth.value;
  return !!pending && pending.id === record.value?.id;
});
const savedDepth = computed(
  () =>
    record.value?.root_zone?.root_depth_cm ??
    record.value?.settings?.planned_wetting_depth_cm ??
    40,
);
const depthChanged = computed(
  () =>
    canExplore.value &&
    liveDepth.value !== record.value?.root_zone?.root_depth_cm,
);
const liveMetrics = computed(() =>
  canExplore.value && explorer.value?.ready
    ? {
        ...record.value?.metrics,
        ...explorer.value.values,
      }
    : record.value?.metrics,
);
const interactive = computed(
  () =>
    completed.value &&
    record.value?.root_zone?.total_scope === "full_profile" &&
    view.value === "wetting",
);
const completed = computed(() => record.value?.status === "completed");
const imageKind = computed(() =>
  view.value === "clusters" && blurred.value ? "clusters_blurred" : view.value,
);
const colors = computed(() => record.value?.colors?.[imageKind.value] || []);
// 两组共用同一套数值与单位样式，保留染色和根区数据原有的显示精度。
const flowMetrics = computed(() => [
  {
    key: "stained_ratio",
    name: t("metrics.stained_ratio"),
    unit: "%",
  },
  {
    key: "stained_area_cm2",
    name: t("metrics.stained_area_cm2"),
    unit: "cm²",
  },
  {
    key: "priority_percentage",
    name: t("metrics.priority_percentage"),
    unit: "%",
  },
  {
    key: "priority_area_ratio",
    name: t("metrics.priority_area_ratio"),
    unit: "%",
  },
  {
    key: "matrix_depth_cm",
    name: t("metrics.matrix_depth_cm"),
    unit: "cm",
  },
  {
    key: "maximum_depth_cm",
    name: t("metrics.maximum_depth_cm"),
    unit: "cm",
  },
  {
    key: "length_index",
    name: t("metrics.length_index"),
    unit: "",
  },
]);
// 根区只列三个百分数，随当前湿润层边界更新。
const rootMetrics = computed(() => [
  {
    key: "rdpr_percent",
    name: t("metrics.rdpr_percent"),
    unit: "%",
  },
  {
    key: "ea_percent",
    name: t("metrics.ea_percent"),
    unit: "%",
  },
  {
    key: "es_percent",
    name: t("metrics.es_percent"),
    unit: "%",
  },
]);
const profileHeight = computed(() => processingSettings.value?.soil_height_cm);
const metricGroups = computed(() => {
  // 保留两组原有精度。根区读实时预览，优先流读本次分析的测定结果。
  const groups = [
    {
      id: "root",
      label: t("rootZone.title"),
      metrics: rootMetrics.value,
      values: liveMetrics.value,
      digits: 4,
    },
    {
      id: "flow",
      label: t("analysis.indicators"),
      metrics: flowMetrics.value,
      values: record.value?.metrics,
      digits: 2,
    },
  ];

  // 百分比共用 0–100，深度以本次分析的剖面深度为满刻度。
  return groups.map((group) => {
    const metrics = group.metrics.map((metric) => {
      const value = completed.value ? group.values?.[metric.key] : undefined;
      const scale =
        metric.unit === "%"
          ? 100
          : metric.unit === "cm"
            ? profileHeight.value
            : undefined;
      const fraction = metricFraction(value, scale);
      const reading = format(value, group.digits);
      return {
        ...metric,
        reading,
        fraction,
      };
    });
    return {
      id: group.id,
      label: group.label,
      metrics,
    };
  });
});

function metricFraction(
  value: number | null | undefined,
  scale: number | undefined,
) {
  // 无有效刻度的指标只显示原值，零值保留完整刻度轨道。
  if (value == null || !Number.isFinite(value)) return undefined;
  if (scale == null || !Number.isFinite(scale) || scale <= 0) return undefined;
  return Math.max(0, Math.min(1, value / scale));
}

// 历史结果使用当时保存的物理边界，修改全局设置后由重新分析生成新快照。
const rootBounds = computed(() => {
  const saved = record.value?.root_zone;
  const settings = processingSettings.value;
  return t("rootZone.bounds", {
    root: format(
      liveDepth.value ??
        saved?.root_depth_cm ??
        settings?.planned_wetting_depth_cm ??
        40,
      6,
    ),
    total: format(saved?.total_depth_cm ?? settings?.soil_height_cm ?? 50, 6),
  });
});
// 旧版的深度不足原因仍按当时固定的 40/50 cm 计算边界解释。
const rootNote = computed(() => {
  // 当前掩膜已经可交互时，状态随预览更新；保存操作由按钮文字说明。
  if (canExplore.value && explorer.value?.ready) {
    if (liveDepth.value! > record.value!.settings!.soil_height_cm)
      return t("rootZone.insufficient_depth");
    if (explorer.value.values.a_tot === 0) return t("rootZone.zero_staining");
    return "";
  }
  const root = record.value?.root_zone;
  const legacyIncomplete =
    root?.status === "insufficient_depth" && !root.total_scope;
  if (root?.status === "ok") return "";
  const key = legacyIncomplete
    ? "legacy_insufficient_depth"
    : root?.status || "not_computed";
  return t("rootZone." + key);
});
watch(
  () => [record.value?.id, record.value?.root_zone?.total_scope],
  () => {
    // 自动分析替换同一图的记录时保留当前视图和图像选项。
    if (record.value && record.value.id === automaticResult.value) return;
    automaticResult.value = undefined;
    // 旧记录没有图版选项时回到有效导出类型。
    if (!canExplore.value && exportKind.value === "figure")
      exportKind.value = "bundle";
    // 新记录优先显示湿润层染色图，已有历史继续打开其可用的参考线图。
    view.value = record.value?.root_zone?.total_scope ? "wetting" : "annotated";
    blurred.value = false;
  },
);

function choose(event: Event) {
  const element = event.target as HTMLInputElement;
  const files = Array.from(element.files || []);
  if (files.length) analyzeFiles(files);
  element.value = "";
}
async function readEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((resolve) =>
      (entry as FileSystemFileEntry).file(
        (file) => {
          // 拖入文件夹时保留相对路径，与文件夹选择入口的命名规则一致。
          Object.defineProperty(file, "webkitRelativePath", {
            value: entry.fullPath.replace(/^\//, ""),
          });
          resolve([file]);
        },
        () => resolve([]),
      ),
    );
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const files: File[] = [];
  while (true) {
    const children = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    );
    if (!children.length) break;
    for (const child of children) files.push(...(await readEntry(child)));
  }
  return files;
}
async function drop(event: DragEvent) {
  dragging.value = false;
  if (!event.dataTransfer) return;
  const entries = Array.from(event.dataTransfer.items)
    .map((item) => item.webkitGetAsEntry())
    .filter(Boolean) as FileSystemEntry[];
  const groups = await Promise.all(entries.map(readEntry));
  const files = groups.length
    ? groups.flat()
    : Array.from(event.dataTransfer.files);
  analyzeFiles(files);
}
function changeDepth(event: Event) {
  // 只在编辑确认后读取数值。空项和越界值还原为当前深度。
  const input = event.currentTarget as HTMLInputElement;
  const depth = input.valueAsNumber;
  const valid = input.validity.valid && Number.isFinite(depth);
  if (!valid) {
    input.value = String(liveDepth.value);
    return;
  }
  void commitDepth(depth);
}
async function commitDepth(depth: number) {
  // 合并 Enter 与 change 事件，同一深度不重复生成历史。
  const original = record.value;
  if (!completed.value || !original?.settings || busy.value) return;
  if (depth === savedDepth.value) return;

  // 输入和对比点选择也立即更新预览，等待时保留原画面。
  const previous = savedDepth.value;
  explorer.value?.setDepth(depth);
  pendingDepth.value = {
    id: original.id,
    depth,
  };
  try {
    const result = await analyzeAtDepth(original, depth);
    if (!result) {
      // 用户重新选择旧记录时，恢复它的已保存边界。
      if (state.active?.id === original.id) explorer.value?.setDepth(previous);
      return;
    }
    automaticResult.value = result.id;
    if (!original.root_zone?.total_scope) view.value = "wetting";
    state.active = result;
  } catch (error) {
    // 自动分析失败后恢复上次保存的深度，用户可重新编辑。
    if (state.active?.id === original.id) explorer.value?.setDepth(previous);
    report(error);
  } finally {
    pendingDepth.value = undefined;
  }
}
async function download() {
  // 等待自动分析完成，常规导出始终使用当前已保存的结果。
  if (busy.value || depthChanged.value) return;
  if (exportKind.value === "figure") {
    state.exporting = true;
    try {
      await explorer.value?.exportFigure();
    } finally {
      state.exporting = false;
    }
    return;
  }
  const kind =
    exportKind.value === "image" ? imageKind.value : exportKind.value;
  await exportArtifact(kind);
}
</script>

<template>
  <div class="page analysis-page">
    <header class="page-header">
      <div>
        <h1>{{ t("nav.analysis") }}</h1>
      </div>
      <div class="header-actions">
        <template v-if="completed"
          ><select
            v-model="exportKind"
            :aria-label="t('export.format')"
            class="export-select"
          >
            <option v-if="canExplore" value="figure">
              {{ t("explorer.figureFormat") }}
            </option>
            <option value="bundle">{{ t("export.bundle") }}</option>
            <option value="image">{{ t("export.image") }}</option>
            <option value="matrix">{{ t("export.matrix") }}</option>
            <option value="profile">{{ t("export.profile") }}</option>
            <option value="metrics">{{ t("export.metrics") }}</option></select
          ><button
            class="button"
            :disabled="state.exporting || busy || depthChanged"
            @click="download"
          >
            <span v-if="state.exporting" class="spinner small-spinner"></span
            ><Icon v-else name="download" :size="17" />{{
              state.exporting ? t("export.busy") : t("export.button")
            }}
          </button></template
        >
        <button class="button primary" :disabled="busy" @click="input?.click()">
          <Icon name="upload" :size="17" />{{ t("analysis.import") }}
        </button>
        <button
          class="button folder-import"
          :disabled="busy"
          :aria-label="t('batch.folder')"
          :title="t('batch.folder')"
          @click="folderInput?.click()"
        >
          <Icon name="folder" :size="17" /></button
        ><input
          ref="folderInput"
          class="visually-hidden"
          type="file"
          multiple
          webkitdirectory
          @change="choose"
          :aria-label="t('batch.folder')"
        /><input
          ref="input"
          class="visually-hidden"
          type="file"
          accept="image/png,image/jpeg"
          multiple
          @change="choose"
          :aria-label="t('analysis.importLabel')"
        />
      </div>
    </header>
    <div class="analysis-context">
      <div>
        <span class="status-dot"></span
        >{{
          completed
            ? t("analysis.completed")
            : busy
              ? t("analysis.running")
              : t("analysis.ready")
        }}<span class="context-divider"></span
        ><span class="context-filename">{{
          record?.name || t("analysis.noFile")
        }}</span>
      </div>
      <div class="context-actions">
        <button class="text-button" @click="workspace?.reset()">
          <Icon name="grid" :size="15" />{{ t("cards.reset") }}
        </button>
        <button class="text-button" @click="state.page = 'settings'">
          <Icon name="settings" :size="15" />{{ t("analysis.parameters") }}
        </button>
      </div>
    </div>
    <BatchQueue />
    <CardWorkspace ref="workspace" :mode="interactive ? 'wetting' : 'standard'">
      <template #image>
        <section
          class="panel image-panel"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="drop"
        >
          <div class="image-toolbar">
            <div class="segmented image-tabs">
              <button
                v-for="item in [
                  {
                    id: 'original',
                    label: t('image.original'),
                  },
                  {
                    id: 'mask',
                    label: t('image.mask'),
                  },
                  {
                    id: 'wetting',
                    label: t('image.wetting'),
                  },
                  {
                    id: 'annotated',
                    label: t('image.annotated'),
                  },
                  {
                    id: 'clusters',
                    label: 'K-means',
                  },
                ]"
                :key="item.id"
                :class="{ selected: view === item.id }"
                :disabled="
                  !completed ||
                  (item.id === 'clusters' &&
                    !record?.settings?.enable_clustering) ||
                  (item.id === 'wetting' && !record?.root_zone?.total_scope)
                "
                @click="view = item.id"
              >
                {{ item.label }}
              </button>
            </div>
            <button
              class="icon-button"
              :aria-label="t('image.zoom')"
              :disabled="!completed"
              @click="interactive ? explorer?.zoom() : modal?.showModal()"
            >
              <Icon name="zoom" :size="18" />
            </button>
          </div>
          <div class="image-canvas" :class="{ dragging, empty: !completed }">
            <WettingExplorer
              v-if="canExplore && record"
              v-show="interactive"
              ref="explorer"
              :record="record"
              :processing="busy"
              :preserve-preview="record.id === automaticResult"
              @commit-depth="commitDepth"
            />
            <img
              v-if="completed && record && !interactive"
              :src="imageUrl(record, imageKind)"
              :alt="record.name"
              @click="modal?.showModal()"
            />
            <div v-else-if="!completed && busy" class="processing-state">
              <span class="spinner large-spinner"></span>
              <h3>{{ t("stages." + (record?.stage || "uploading")) }}</h3>
              <p>{{ state.filename || record?.name }}</p>
              <div class="activity-line"></div>
            </div>
            <div v-else-if="record?.status === 'failed'" class="empty-state">
              <span class="empty-symbol"><Icon name="info" :size="28" /></span>
              <h3>{{ t("analysis.failedTitle") }}</h3>
              <p>{{ t(record.error || "errors.generic") }}</p>
              <button class="button" @click="input?.click()">
                {{ t("analysis.chooseAgain") }}
              </button>
            </div>
            <button
              v-else-if="!completed"
              class="dropzone"
              :disabled="busy"
              @click="input?.click()"
            >
              <span class="empty-symbol"
                ><Icon name="upload" :size="28"
              /></span>
              <h3>{{ t("analysis.dropTitle") }}</h3>
              <p>{{ t("analysis.dropAction") }}</p>
              <span class="file-hint">{{ t("analysis.fileHint") }}</span>
            </button>
          </div>
          <div class="image-footer">
            <template v-if="completed"
              ><span
                >{{ record?.settings?.resolution_width }} ×
                {{ record?.settings?.resolution_height }} px</span
              ><label v-if="view === 'clusters'" class="inline-toggle"
                ><input v-model="blurred" type="checkbox" />{{
                  processingLabel
                }}</label
              ><span v-else-if="view === 'wetting'" class="wetting-legend"
                ><span>Zr = {{ format(liveDepth, 6) }} cm</span
                ><i class="retained-swatch"></i>{{ t("image.retained")
                }}<i class="leakage-swatch"></i>{{ t("image.leakage") }}</span
              ><span v-else-if="view === 'annotated'" class="line-legend"
                ><i class="line-red"></i>{{ t("image.matrixLine")
                }}<i class="line-blue"></i>{{ t("settings.startDepth")
                }}<i class="line-green"></i>{{ t("history.depth") }}</span
              ><span v-else-if="view === 'mask'">{{
                t("image.blackStain")
              }}</span
              ><span v-else>{{ t("image.originalFull") }}</span></template
            >
            <template v-else
              ><span>{{ t("analysis.local") }}</span
              ><span>{{ t("analysis.localFiles") }}</span></template
            >
          </div>
        </section>
      </template>
      <template #metrics>
        <section class="panel metrics-panel">
          <div class="panel-heading">
            <h2>{{ t("analysis.metricsTitle") }}</h2>
          </div>
          <div class="metrics-content">
            <!-- 分组便于找数值，两组共用标签、数字和单位的排版。 -->
            <section
              v-for="group in metricGroups"
              :key="group.id"
              class="metric-group"
            >
              <h3>{{ group.label }}</h3>
              <template v-if="group.id === 'root'">
                <template v-if="completed && record?.settings">
                  <div class="root-controls">
                    <label
                      >{{ t("settings.plannedWettingDepth") }}
                      <input
                        :value="liveDepth"
                        type="number"
                        min="0.01"
                        :max="record?.settings?.soil_height_cm"
                        step="any"
                        :disabled="busy || (canExplore && !explorer?.ready)"
                        @change="changeDepth"
                        @keydown.enter.prevent="changeDepth"
                      />
                      cm</label
                    >
                    <span
                      v-if="applyingDepth"
                      class="depth-progress"
                      role="status"
                    >
                      <span
                        class="spinner small-spinner"
                        aria-hidden="true"
                      ></span>
                      {{ t("analysis.running") }}
                    </span>
                  </div>
                </template>
                <div v-else class="metric-context">
                  <span>{{ rootBounds }}</span>
                </div>
              </template>
              <dl
                class="metric-values"
                :class="{ 'root-metrics': group.id === 'root' }"
              >
                <div
                  v-for="metric in group.metrics"
                  :key="metric.key"
                  :data-metric="metric.key"
                >
                  <dt>{{ metric.name }}</dt>
                  <dd>
                    <span class="metric-reading">
                      {{ metric.reading }}
                      <span v-if="metric.unit" class="metric-unit">{{
                        metric.unit
                      }}</span>
                    </span>
                    <span
                      v-if="metric.fraction !== undefined"
                      class="metric-track"
                      :class="{ 'is-loss': metric.key === 'rdpr_percent' }"
                      aria-hidden="true"
                    >
                      <span
                        :style="{
                          transform: 'scaleX(' + metric.fraction + ')',
                        }"
                      ></span>
                    </span>
                  </dd>
                </div>
              </dl>
              <template v-if="group.id === 'root'">
                <p v-if="completed && rootNote" class="metric-context">
                  {{ rootNote }}
                </p>
              </template>
              <p v-else class="metric-context profile-size">
                {{ t("analysis.profile") }}
                {{ processingSettings?.soil_width_cm }} ×
                {{ processingSettings?.soil_height_cm }} cm
              </p>
            </section>
          </div>
        </section>
      </template>
      <template #response>
        <DepthResponse
          v-if="canExplore && record"
          v-show="interactive"
          :counts="explorer?.counts || []"
          :width="record.settings!.resolution_width"
          :height="record.settings!.soil_height_cm"
          :depth="liveDepth!"
          :pins="explorer?.pins || []"
          @pin="explorer?.pinDepth()"
          @select="commitDepth"
          @remove="explorer?.removePin($event)"
        />
        <DepthChart
          v-if="completed && record"
          v-show="!interactive"
          :record="record"
          :planned-depth="liveDepth"
        />
        <section v-else class="panel chart-panel empty-chart">
          <div class="panel-heading">
            <h2>{{ t("chart.title") }}</h2>
          </div>
          <div class="empty-plot">
            <Icon name="chart" :size="32" />
            <p>{{ t("analysis.noChart") }}</p>
          </div>
        </section>
      </template>
      <template #details>
        <section class="panel details-panel">
          <div class="panel-heading">
            <h2>
              {{
                view === "clusters" && completed
                  ? t("analysis.colorDistribution")
                  : t("analysis.details")
              }}
            </h2>
            <Icon :name="view === 'clusters' ? 'grid' : 'info'" :size="17" />
          </div>
          <div
            v-if="view === 'clusters' && completed"
            class="color-distribution"
          >
            <div v-for="color in colors" :key="color.color" class="color-row">
              <span
                class="color-swatch"
                :style="`background:${color.color}`"
              ></span>
              <div>
                <span>{{ color.color.toUpperCase() }}</span
                ><small>{{ format(color.area_cm2) }} cm²</small>
              </div>
              <strong>{{ format(color.ratio) }}<small>%</small></strong>
            </div>
          </div>
          <dl v-else class="analysis-details">
            <div>
              <dt>{{ t("settings.method") }}</dt>
              <dd>
                {{
                  t(
                    "method." +
                      (record?.effective_method ||
                        (record?.settings || state.settings)?.method ||
                        "auto"),
                  )
                }}
              </dd>
            </div>
            <div>
              <dt>{{ processingLabel }}</dt>
              <dd>{{ processingDetails }}</dd>
            </div>
            <div>
              <dt>{{ t("settings.clustering") }}</dt>
              <dd>
                {{
                  (record?.settings || state.settings)?.enable_clustering
                    ? t("settings.classes", {
                        count: (record?.settings || state.settings)?.clusters,
                      })
                    : t("common.off")
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t("analysis.timestamp") }}</dt>
              <dd>{{ record ? date(record.created_at) : "—" }}</dd>
            </div>
          </dl>
          <div class="details-note">
            <Icon name="info" :size="15" /><span>{{
              view === "clusters"
                ? t("analysis.colorNote")
                : t("analysis.calibrationNote")
            }}</span>
          </div>
        </section>
      </template>
    </CardWorkspace>
    <dialog ref="modal" class="image-modal" @click="modal?.close()">
      <button
        class="icon-button modal-close"
        :aria-label="t('image.closeZoom')"
        @click="modal?.close()"
      >
        <Icon name="close" /></button
      ><img
        v-if="completed && record"
        :src="imageUrl(record, imageKind)"
        :alt="record.name"
      />
    </dialog>
  </div>
</template>
