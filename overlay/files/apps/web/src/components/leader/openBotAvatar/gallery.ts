import { examples } from "./examples";
import type { AvatarDefinition } from "./types";

export interface OpenBotAvatarCatalogEntry {
  readonly definition: AvatarDefinition;
  readonly defaultColor: string;
  readonly labelZh: string;
  readonly labelEn: string;
}

const GALLERY_DEFINITIONS = {
  "cat": {
    "version": 1 as const,
    "id": "cat",
    "name": "Cat",
    "body": {
      "path": "M50 23C68 23 82 30 82 45C82 58 68 65 50 65C32 65 18 58 18 45C18 30 32 23 50 23ZM24 42C21 32 20 22 22 15C23 11 26 10 29 12C34 16 39 21 44 28L36 42ZM64 42L56 28C61 21 66 16 71 12C74 10 77 11 78 15C80 22 79 32 76 42ZM38 56L62 56C70 56 74 66 74 76C74 83 70 86 63 86L37 86C30 86 26 83 26 76C26 66 30 56 38 56ZM70 72C77 74 81 70 80 64C79 60 81 57 84 58C87 59 88.5 63 88 68C87 77 80 83 70 81Z"
    },
    "eyes": {
      "x": 50,
      "y": 43,
      "spacing": 17,
      "scale": 1.1
    }
  },
  "rocket": {
    "version": 1 as const,
    "id": "rocket",
    "name": "Rocket",
    "body": {
      "path": "M46 10C48 8.5 52 8.5 54 10C64 17 71 29 71 44V69C71 74 68 77 63 77H37C32 77 29 74 29 69V44C29 29 36 17 46 10ZM65 50L70.5 52C79 57 87 68 87 81C87 85.5 84 88 80.5 86.5L65 76ZM35 76L19.5 86.5C16 88 13 85.5 13 81C13 68 21 57 29.5 52L35 50ZM41 74H59C60 82 56 88 50 91C44 88 40 82 41 74Z"
    },
    "eyes": {
      "x": 50,
      "y": 46,
      "spacing": 15,
      "scale": 1.05
    }
  },
  "ghost": {
    "version": 1 as const,
    "id": "ghost",
    "name": "Ghost",
    "body": {
      "path": "M24 50C24 28 35 12 50 12C65 12 76 28 76 50L77 80C77 85 73 88 68 88C63 88 61 84 59 81C57 84 54 88 50 88C46 88 43 84 41 81C39 84 37 88 32 88C27 88 23 85 23 80Z"
    },
    "eyes": {
      "x": 50,
      "y": 42,
      "spacing": 16,
      "scale": 1.15
    }
  },
  "star": {
    "version": 1 as const,
    "id": "star",
    "name": "Star",
    "body": {
      "path": "M53.7 17.95L62 31.2Q64.1 34.6 68 35.6L83.1 39.3Q89.9 41 85.4 46.4L75.4 58.3Q72.8 61.4 73.1 65.4L74.2 81Q74.7 88 68.2 85.4L53.7 79.5Q50 78 46.3 79.5L31.8 85.4Q25.3 88 25.8 81L26.9 65.4Q27.2 61.4 24.6 58.3L14.6 46.4Q10.1 41 16.9 39.3L32 35.6Q35.9 34.6 38 31.2L46.3 17.95Q50 12 53.7 17.95Z"
    },
    "eyes": {
      "x": 50,
      "y": 52,
      "spacing": 16,
      "scale": 1.1
    }
  },
  "cloud": {
    "version": 1 as const,
    "id": "cloud",
    "name": "Cloud",
    "body": {
      "path": "M24 76C14 76 9 69 9 61C9 52 15 46 23 45.5C25 33 36 24 49 24C61 24 70 31 73 41C83 41 91 49 91 59C91 69 83 76 74 76Z"
    },
    "eyes": {
      "x": 50,
      "y": 54,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "bunny": {
    "version": 1 as const,
    "id": "bunny",
    "name": "Bunny",
    "body": {
      "path": "M50 40C68 40 80 50 80 64C80 78 68 86 50 86C32 86 20 78 20 64C20 50 32 40 50 40ZM30 46C26 36 24 24 26 16C28 10 34 10 37 15C40 22 42 34 42 44ZM58 44C58 34 61 22 66 15C69 10 76 11 76 17C76 25 74 36 70 46Z"
    },
    "eyes": {
      "x": 50,
      "y": 62,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "brain": {
    "version": 1 as const,
    "id": "brain",
    "name": "Brain",
    "body": {
      "path": "M14 50C10 42 14 32 22 30C24 21 34 17 41 21C46 15 56 15 61 20C68 16 78 20 79 28C87 30 91 39 88 47C92 54 89 64 81 66C80 71 76 74 71 73C67 75 64 74 62 72C61 74 61 76 61.5 78C62 81 59 82.5 57 81.5C55.5 80.5 55 78 54 76C53 74 50 72.5 47 72.5C42 74 38 72 36 70C30 73 20 71 18 64C12 62 10 56 14 50Z"
    },
    "eyes": {
      "x": 50,
      "y": 45,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "book": {
    "version": 1 as const,
    "id": "book",
    "name": "Book",
    "body": {
      "path": "M12 32C12 29 14 27 17 26C30 21.5 42 23 50 31C58 23 70 21.5 83 26C86 27 88 29 88 32V64H89C90.7 64 92 65.3 92 67V75C92 77 90.5 78 88.5 77.5C76 75 60 76 50 84C40 76 24 75 11.5 77.5C9.5 78 8 77 8 75V67C8 65.3 9.3 64 11 64H12Z"
    },
    "eyes": {
      "x": 50,
      "y": 51,
      "spacing": 18,
      "scale": 1.1
    }
  },
  "camera": {
    "version": 1 as const,
    "id": "camera",
    "name": "Camera",
    "body": {
      "path": "M17 34H20V31C20 29 21 28 23 28H27C29 28 30 29 30 31V34H36L40 23C41 21 42 20 44 20H56C58 20 59 21 60 23L64 34H83C87.5 34 91 37.5 91 42V72C91 76.5 87.5 80 83 80H17C12.5 80 9 76.5 9 72V42C9 37.5 12.5 34 17 34Z"
    },
    "eyes": {
      "x": 50,
      "y": 54,
      "spacing": 17,
      "scale": 1.1
    }
  },
  "egg": {
    "version": 1 as const,
    "id": "egg",
    "name": "Egg",
    "body": {
      "path": "M50 10C66 10 82 34 82 58C82 76 68 88 50 88C32 88 18 76 18 58C18 34 34 10 50 10Z"
    },
    "eyes": {
      "x": 50,
      "y": 54,
      "spacing": 17,
      "scale": 1.2
    }
  },
  "magnifier": {
    "version": 1 as const,
    "id": "magnifier",
    "name": "Magnifier",
    "body": {
      "path": "M41 12A29 29 0 0 1 64.44 58.08L68.50 62.13A8 8 0 0 1 75.65 64.33L87.67 76.36A8 8 0 0 1 76.36 87.67L64.33 75.65A8 8 0 0 1 62.13 68.50L58.08 64.44A29 29 0 1 1 41 12Z"
    },
    "eyes": {
      "x": 41,
      "y": 40,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "paint-brush": {
    "version": 1 as const,
    "id": "paint-brush",
    "name": "Paint Brush",
    "body": {
      "path": "M77.2 8.5C80.3 8.7 82.3 10.2 83.4 13.1C84 14.5 83.3 16.2 82.3 17.6L65.9 40.8L56.2 33.7L73.2 11C74.2 9.6 75.6 8.5 77.2 8.5ZM55.4 26.8L72.8 39.4C74.2 40.4 74.5 42.2 73.5 43.6L66.6 53C65.6 54.4 63.8 54.7 62.4 53.7L45.1 41C43.7 40 43.4 38.2 44.4 36.8L51.2 27.4C52.2 26 54 25.8 55.4 26.8ZM48.4 38.7L63.7 49.8C67.9 57.1 66.8 65.9 61.8 72.9C54.7 82.6 41.2 86.6 25.2 85.1C22.2 85 20 82.9 21 79.9C24.6 71.4 21.1 57.1 28.2 47.4C33.3 40.4 40.8 37.4 48.4 38.7Z"
    },
    "eyes": {
      "x": 44,
      "y": 59,
      "spacing": 16,
      "scale": 1.05
    }
  },
  "palette": {
    "version": 1 as const,
    "id": "palette",
    "name": "Palette",
    "body": {
      "path": "M46 18C70 16 90 28 90 48C90 68 74 84 52 84C42 84 36 80 34 74C32 68 36 64 32 60C28 56 22 62 16 58C10 54 10 46 12 40C16 26 30 19 46 18ZM20 42A6.5 8 0 1 0 33 42A6.5 8 0 1 0 20 42Z"
    },
    "eyes": {
      "x": 58,
      "y": 46,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "shield": {
    "version": 1 as const,
    "id": "shield",
    "name": "Shield",
    "body": {
      "path": "M50 14C60 18 72 18 82 16Q86 16 86 20L86 46C86 64 72 78 54 86.5Q50 88.5 46 86.5C28 78 14 64 14 46L14 20Q14 16 18 16C28 18 40 18 50 14Z"
    },
    "eyes": {
      "x": 50,
      "y": 42,
      "spacing": 17,
      "scale": 1.15
    }
  },
  "witch-hat": {
    "version": 1 as const,
    "id": "witch-hat",
    "name": "Witch Hat",
    "body": {
      "path": "M50 72C72 72 92 75 92 80C92 85 72 87 50 87C28 87 8 85 8 80C8 75 28 72 50 72ZM50 14.73C60.78 18.98 67.14 27.15 69.44 38L77.5 76Q78 80 74 80L26 80Q22 80 22.5 76L30.56 38C32.86 27.15 39.22 18.98 50 14.73ZM41.58 19.5C44.5 17.2 47.97 15.34 52 14C62 10.5 72 9 81 11A3.2 3.2 0 0 1 81 17.4C75.5 18.2 67.96 31 69.44 38L64 30L56 22L48 20Z"
    },
    "eyes": {
      "x": 50,
      "y": 54,
      "spacing": 15,
      "scale": 1.05
    }
  },
  "bull": {
    "version": 1 as const,
    "id": "bull",
    "name": "Bull",
    "body": {
      "path": "M40 28L60 28C70 28 76 36 76 48L76 62C76 74 66 84 50 84C34 84 24 74 24 62L24 48C24 36 30 28 40 28ZM32 40C22 38 15 32 15 24C15 18 18 13 22 10C25 8 28 10 27 13C25 18 24 22 28 26C31 29 36 30 42 30ZM58 30C64 30 69 29 72 26C76 22 75 18 73 13C72 10 75 8 78 10C82 13 85 18 85 24C85 32 78 38 68 40ZM29 55C23 56 17 55 12 52C9 50 8 47 10 45C14 41 22 40 28 42ZM72 42C78 40 86 41 90 45C92 47 91 50 88 52C83 55 77 56 71 55Z"
    },
    "eyes": {
      "x": 50,
      "y": 52,
      "spacing": 17,
      "scale": 1.15
    }
  },
} satisfies Record<string, AvatarDefinition>;

function requireExample(id: string): AvatarDefinition {
  const match = examples.find((item) => item.id === id);
  if (!match) {
    throw new Error(`Missing open-bot-avatar example definition: ${id}`);
  }
  return match;
}

export const OPEN_BOT_AVATAR_PALETTE: readonly string[] = [
  "#f4f4f4",
  "#a8693f",
  "#f2384b",
  "#ff6a1a",
  "#f8a01c",
  "#1fbf68",
  "#14b3a5",
  "#1f7cf2",
  "#8b5cf6",
  "#ec4899",
  "#7a7a7a",
];

export const OPEN_BOT_AVATAR_CATALOG: readonly OpenBotAvatarCatalogEntry[] = [
  {
    definition: GALLERY_DEFINITIONS["cat"],
    defaultColor: "#f8a01c",
    labelZh: "猫咪",
    labelEn: "Cat",
  },
  {
    definition: GALLERY_DEFINITIONS["rocket"],
    defaultColor: "#7a7a7a",
    labelZh: "火箭",
    labelEn: "Rocket",
  },
  {
    definition: GALLERY_DEFINITIONS["ghost"],
    defaultColor: "#f4f4f4",
    labelZh: "幽灵",
    labelEn: "Ghost",
  },
  {
    definition: requireExample("mug"),
    defaultColor: "#f4f4f4",
    labelZh: "咖啡杯",
    labelEn: "Mug",
  },
  {
    definition: GALLERY_DEFINITIONS["star"],
    defaultColor: "#ff6a1a",
    labelZh: "星星",
    labelEn: "Star",
  },
  {
    definition: requireExample("lightbulb"),
    defaultColor: "#f8a01c",
    labelZh: "灯泡",
    labelEn: "Lightbulb",
  },
  {
    definition: requireExample("chat"),
    defaultColor: "#8b5cf6",
    labelZh: "气泡",
    labelEn: "Chat",
  },
  {
    definition: requireExample("sprout"),
    defaultColor: "#1fbf68",
    labelZh: "幼苗",
    labelEn: "Sprout",
  },
  {
    definition: requireExample("controller"),
    defaultColor: "#ff6a1a",
    labelZh: "手柄",
    labelEn: "Controller",
  },
  {
    definition: GALLERY_DEFINITIONS["cloud"],
    defaultColor: "#14b3a5",
    labelZh: "云朵",
    labelEn: "Cloud",
  },
  {
    definition: GALLERY_DEFINITIONS["bunny"],
    defaultColor: "#ec4899",
    labelZh: "兔子",
    labelEn: "Bunny",
  },
  {
    definition: GALLERY_DEFINITIONS["brain"],
    defaultColor: "#ec4899",
    labelZh: "大脑",
    labelEn: "Brain",
  },
  {
    definition: GALLERY_DEFINITIONS["book"],
    defaultColor: "#a8693f",
    labelZh: "书本",
    labelEn: "Book",
  },
  {
    definition: GALLERY_DEFINITIONS["camera"],
    defaultColor: "#7a7a7a",
    labelZh: "相机",
    labelEn: "Camera",
  },
  {
    definition: GALLERY_DEFINITIONS["egg"],
    defaultColor: "#f4f4f4",
    labelZh: "彩蛋",
    labelEn: "Egg",
  },
  {
    definition: GALLERY_DEFINITIONS["magnifier"],
    defaultColor: "#1f7cf2",
    labelZh: "放大镜",
    labelEn: "Magnifier",
  },
  {
    definition: GALLERY_DEFINITIONS["paint-brush"],
    defaultColor: "#1fbf68",
    labelZh: "画笔",
    labelEn: "Paint Brush",
  },
  {
    definition: GALLERY_DEFINITIONS["palette"],
    defaultColor: "#a8693f",
    labelZh: "调色盘",
    labelEn: "Palette",
  },
  {
    definition: GALLERY_DEFINITIONS["shield"],
    defaultColor: "#1f7cf2",
    labelZh: "盾牌",
    labelEn: "Shield",
  },
  {
    definition: GALLERY_DEFINITIONS["witch-hat"],
    defaultColor: "#8b5cf6",
    labelZh: "巫师帽",
    labelEn: "Witch Hat",
  },
  {
    definition: GALLERY_DEFINITIONS["bull"],
    defaultColor: "#f2384b",
    labelZh: "公牛",
    labelEn: "Bull",
  },
  {
    definition: requireExample("barbell"),
    defaultColor: "#f2384b",
    labelZh: "杠铃",
    labelEn: "Barbell",
  },
  {
    definition: requireExample("watering-can"),
    defaultColor: "#14b3a5",
    labelZh: "水壶",
    labelEn: "Watering Can",
  },
];

const OPEN_BOT_AVATAR_CATALOG_BY_ID = new Map<string, OpenBotAvatarCatalogEntry>(
  OPEN_BOT_AVATAR_CATALOG.map((entry) => [entry.definition.id, entry]),
);

export function getOpenBotAvatarEntry(shapeId: string): OpenBotAvatarCatalogEntry | undefined {
  return OPEN_BOT_AVATAR_CATALOG_BY_ID.get(shapeId);
}
