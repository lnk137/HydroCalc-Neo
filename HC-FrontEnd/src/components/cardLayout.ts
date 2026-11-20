export type CardId = "image" | "metrics" | "response" | "details";

export type Rectangle = {
  id: CardId;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DropSlot = {
  card: Rectangle;
  layout: Rectangle[];
};

export const cardGap = 16;
export const singleColumnWidth = 720;

function readingOrder(layout: Rectangle[]) {
  // 保留原本从上到下、从左到右的相对顺序，方便旧的自由布局收紧。
  return [...layout].sort(
    (first, second) => first.y - second.y || first.x - second.x,
  );
}

function inDomOrder(layout: Rectangle[], placed: Rectangle[]) {
  // 排版顺序改变时保留 DOM 顺序和焦点，也避免拖动中重建指针把手。
  return layout.map((card) => placed.find((item) => item.id === card.id)!);
}

function pack(ordered: Rectangle[], width: number): Rectangle[] {
  const placed: Rectangle[] = [];
  const single = width < singleColumnWidth;
  for (const card of ordered) {
    // 落点只能贴住画布边缘或已经安置的卡片边缘。
    const right = width - card.width;
    const anchors = new Set([0]);
    if (!single) {
      anchors.add(right);
      for (const other of placed) {
        anchors.add(other.x);
        anchors.add(other.x + other.width - card.width);
        anchors.add(other.x + other.width + cardGap);
        anchors.add(other.x - card.width - cardGap);
      }
    }

    // 对每个横向落点，从占用这个范围的卡片底边往下接。
    let best: Rectangle | undefined;
    let score = Infinity;
    for (const x of anchors) {
      if (x < 0 || x > right) continue;
      let y = 0;
      for (const other of placed) {
        const needsClearance =
          x < other.x + other.width + cardGap &&
          x + card.width + cardGap > other.x;
        if (needsClearance) y = Math.max(y, other.y + other.height + cardGap);
      }

      // 尽量在原列往上补位，避免旁列暂时腾空时把整列卡片拉过去。
      const nextScore = y + 2 * Math.abs(x - card.x);
      if (nextScore < score) {
        best = {
          ...card,
          x,
          y,
        };
        score = nextScore;
      }
    }
    placed.push(best!);
  }
  return placed;
}

export function compact(layout: Rectangle[], width: number) {
  // 将恢复、缩放或键盘调整后的矩形统一收紧。
  const ordered = readingOrder(layout);
  const placed = pack(ordered, width);
  return inDomOrder(layout, placed);
}

function bottom(layout: Rectangle[]) {
  const bottoms = layout.map((card) => card.y + card.height);
  return Math.max(...bottoms);
}

export function dropSlots(
  layout: Rectangle[],
  active: Rectangle,
  width: number,
): DropSlot[] {
  // 原位置始终可以放回。保留同一落点布局最短的一种，让其它卡片也填上空位。
  const initial = {
    card: active,
    layout,
  };
  const home = active.x + ":" + active.y;
  const slots = new Map([[home, initial]]);
  const ordered = readingOrder(layout);
  const others = ordered.filter((card) => card.id !== active.id);
  const alignments = [active.x, 0, width - active.width];

  // 枚举插入顺序和左右对齐。落点只需在抓起时计算一次。
  for (let index = 0; index <= others.length; index++) {
    for (const x of alignments) {
      const next = {
        ...active,
        x,
      };
      const insertion = [...others];
      insertion.splice(index, 0, next);
      const placed = pack(insertion, width);
      const card = placed.find((item) => item.id === active.id)!;
      const key = card.x + ":" + card.y;
      if (key === home) continue;
      const previous = slots.get(key);
      if (previous && bottom(placed) >= bottom(previous.layout)) continue;

      const arrangement = inDomOrder(layout, placed);
      slots.set(key, {
        card,
        layout: arrangement,
      });
    }
  }
  return [...slots.values()];
}

export function nearestSlot(
  slots: DropSlot[],
  current: DropSlot,
  desired: Rectangle,
) {
  // 只有新落点明显更近时才切换，防止鼠标在两个落点交界处抖动。
  let best = current;
  const currentDistance = Math.hypot(
    current.card.x - desired.x,
    current.card.y - desired.y,
  );
  let distance = currentDistance;
  for (const slot of slots) {
    const nextDistance = Math.hypot(
      slot.card.x - desired.x,
      slot.card.y - desired.y,
    );
    if (nextDistance >= distance) continue;
    best = slot;
    distance = nextDistance;
  }
  return distance + 12 < currentDistance ? best : current;
}
