import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export function usePlotSize(element: Ref<SVGSVGElement | undefined>) {
  // 曲线坐标使用容器的 CSS 像素，避免宽卡里的 SVG 因固定比例缩在中央。
  const width = ref(430);
  const height = ref(230);
  let observer: ResizeObserver;
  onMounted(() => {
    observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      if (entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
      width.value = entry.contentRect.width;
      height.value = entry.contentRect.height;
    });
    observer.observe(element.value!);
  });
  // 卡片被销毁时释放观察，模式切换保留组件时不重复注册。
  onBeforeUnmount(() => observer?.disconnect());
  return {
    width,
    height,
  };
}
