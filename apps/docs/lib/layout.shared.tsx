import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { i18n, type Locale } from './i18n';
import { githubUrl, steamUrl } from './shared';
import { Logo } from '@/components/logo';

/**
 * Fumadocs UI chrome strings (search, table of contents, pagination...) for
 * each locale. English is Fumadocs' built-in default; only displayName is set.
 */
export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: {
      displayName: 'English',
    },
    ru: {
      displayName: 'Русский',
      'Back to Home(404 page)': 'На главную',
      'Choose a language(language switcher)': 'Язык',
      'Choose a language(language switcher)(aria-label)': 'Выбрать язык',
      'Close Banner(banner)(aria-label)': 'Закрыть баннер',
      'Close Search(search dialog)(aria-label)': 'Закрыть поиск',
      'Close Sidebar(aria-label)': 'Закрыть боковую панель',
      'Close Sidebar(sidebar)(aria-label)': 'Закрыть боковую панель',
      'Close(image zoom)(aria-label)': 'Закрыть',
      'Collapse Sidebar(sidebar)(aria-label)': 'Свернуть боковую панель',
      'Copied Anchor Link(heading anchor)(aria-label)': 'Ссылка скопирована',
      'Copied Link(accordion)(aria-label)': 'Ссылка скопирована',
      'Copied Markdown(page actions)': 'Markdown скопирован',
      'Copied Text(code block)(aria-label)': 'Текст скопирован',
      'Copy Anchor Link(heading anchor)(aria-label)': 'Копировать ссылку',
      'Copy Link(accordion)(aria-label)': 'Копировать ссылку',
      'Copy Markdown(page actions)': 'Копировать Markdown',
      'Copy Text(code block)(aria-label)': 'Копировать текст',
      'Dark(theme switcher)(aria-label)': 'Тёмная тема',
      'Edit on GitHub(edit page)': 'Изменить на GitHub',
      'Hide Sidebar(sidebar)': 'Скрыть боковую панель',
      'Image Viewer(image zoom)(aria-label)': 'Просмотр изображения',
      'Last updated on(page footer)': 'Обновлено',
      'Light(theme switcher)(aria-label)': 'Светлая тема',
      'Next Image(image zoom)(aria-label)': 'Следующее изображение',
      'Next Page(pagination)': 'Далее',
      'No Headings(table of contents)': 'Нет заголовков',
      'No results found(search dialog)': 'Ничего не найдено',
      'On this page(table of contents)': 'На этой странице',
      'Open Search(search trigger)(aria-label)': 'Открыть поиск',
      'Open Sidebar(sidebar)(aria-label)': 'Открыть боковую панель',
      'Open(page actions)': 'Открыть',
      'Page Not Found(404 page)': 'Страница не найдена',
      'Previous Image(image zoom)(aria-label)': 'Предыдущее изображение',
      'Previous Page(pagination)': 'Назад',
      'Search failed(search dialog)': 'Ошибка поиска',
      'Search failed, showing results for {query}(search dialog)':
        'Ошибка поиска, результаты для {query}',
      'Search(search dialog)': 'Поиск',
      'Search(search trigger)': 'Поиск',
      'Show Sidebar(sidebar)': 'Показать боковую панель',
      'System(theme switcher)(aria-label)': 'Системная тема',
      'Table of Contents(inline table of contents)': 'Содержание',
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
        'Страница, которую вы ищете, могла быть удалена, переименована или временно недоступна.',
      'Toggle Menu(mobile menu)(aria-label)': 'Меню',
      'Toggle Theme(theme switcher)(aria-label)': 'Сменить тему',
      'View as Markdown(page actions)': 'Открыть как Markdown',
    },
    'zh-CN': {
      displayName: '简体中文',
      'Back to Home(404 page)': '返回首页',
      'Choose a language(language switcher)': '语言',
      'Choose a language(language switcher)(aria-label)': '选择语言',
      'Close Banner(banner)(aria-label)': '关闭横幅',
      'Close Search(search dialog)(aria-label)': '关闭搜索',
      'Close Sidebar(aria-label)': '关闭侧边栏',
      'Close Sidebar(sidebar)(aria-label)': '关闭侧边栏',
      'Close(image zoom)(aria-label)': '关闭',
      'Collapse Sidebar(sidebar)(aria-label)': '收起侧边栏',
      'Copied Anchor Link(heading anchor)(aria-label)': '已复制链接',
      'Copied Link(accordion)(aria-label)': '已复制链接',
      'Copied Markdown(page actions)': '已复制 Markdown',
      'Copied Text(code block)(aria-label)': '已复制',
      'Copy Anchor Link(heading anchor)(aria-label)': '复制链接',
      'Copy Link(accordion)(aria-label)': '复制链接',
      'Copy Markdown(page actions)': '复制 Markdown',
      'Copy Text(code block)(aria-label)': '复制',
      'Dark(theme switcher)(aria-label)': '深色',
      'Edit on GitHub(edit page)': '在 GitHub 上编辑',
      'Hide Sidebar(sidebar)': '隐藏侧边栏',
      'Image Viewer(image zoom)(aria-label)': '图片查看器',
      'Last updated on(page footer)': '最后更新于',
      'Light(theme switcher)(aria-label)': '浅色',
      'Next Image(image zoom)(aria-label)': '下一张',
      'Next Page(pagination)': '下一页',
      'No Headings(table of contents)': '无标题',
      'No results found(search dialog)': '未找到结果',
      'On this page(table of contents)': '本页目录',
      'Open Search(search trigger)(aria-label)': '打开搜索',
      'Open Sidebar(sidebar)(aria-label)': '打开侧边栏',
      'Open(page actions)': '打开',
      'Page Not Found(404 page)': '页面未找到',
      'Previous Image(image zoom)(aria-label)': '上一张',
      'Previous Page(pagination)': '上一页',
      'Search failed(search dialog)': '搜索失败',
      'Search failed, showing results for {query}(search dialog)': '搜索失败，显示 {query} 的结果',
      'Search(search dialog)': '搜索',
      'Search(search trigger)': '搜索',
      'Show Sidebar(sidebar)': '显示侧边栏',
      'System(theme switcher)(aria-label)': '跟随系统',
      'Table of Contents(inline table of contents)': '目录',
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
        '您要查找的页面可能已被删除、更名或暂时不可用。',
      'Toggle Menu(mobile menu)(aria-label)': '切换菜单',
      'Toggle Theme(theme switcher)(aria-label)': '切换主题',
      'View as Markdown(page actions)': '以 Markdown 查看',
    },
    es: {
      displayName: 'Español',
      'Back to Home(404 page)': 'Volver al inicio',
      'Choose a language(language switcher)': 'Idioma',
      'Choose a language(language switcher)(aria-label)': 'Elegir idioma',
      'Close Banner(banner)(aria-label)': 'Cerrar aviso',
      'Close Search(search dialog)(aria-label)': 'Cerrar búsqueda',
      'Close Sidebar(aria-label)': 'Cerrar barra lateral',
      'Close Sidebar(sidebar)(aria-label)': 'Cerrar barra lateral',
      'Close(image zoom)(aria-label)': 'Cerrar',
      'Collapse Sidebar(sidebar)(aria-label)': 'Contraer barra lateral',
      'Copied Anchor Link(heading anchor)(aria-label)': 'Enlace copiado',
      'Copied Link(accordion)(aria-label)': 'Enlace copiado',
      'Copied Markdown(page actions)': 'Markdown copiado',
      'Copied Text(code block)(aria-label)': 'Texto copiado',
      'Copy Anchor Link(heading anchor)(aria-label)': 'Copiar enlace',
      'Copy Link(accordion)(aria-label)': 'Copiar enlace',
      'Copy Markdown(page actions)': 'Copiar Markdown',
      'Copy Text(code block)(aria-label)': 'Copiar texto',
      'Dark(theme switcher)(aria-label)': 'Oscuro',
      'Edit on GitHub(edit page)': 'Editar en GitHub',
      'Hide Sidebar(sidebar)': 'Ocultar barra lateral',
      'Image Viewer(image zoom)(aria-label)': 'Visor de imágenes',
      'Last updated on(page footer)': 'Última actualización',
      'Light(theme switcher)(aria-label)': 'Claro',
      'Next Image(image zoom)(aria-label)': 'Imagen siguiente',
      'Next Page(pagination)': 'Siguiente',
      'No Headings(table of contents)': 'Sin encabezados',
      'No results found(search dialog)': 'No se encontraron resultados',
      'On this page(table of contents)': 'En esta página',
      'Open Search(search trigger)(aria-label)': 'Abrir búsqueda',
      'Open Sidebar(sidebar)(aria-label)': 'Abrir barra lateral',
      'Open(page actions)': 'Abrir',
      'Page Not Found(404 page)': 'Página no encontrada',
      'Previous Image(image zoom)(aria-label)': 'Imagen anterior',
      'Previous Page(pagination)': 'Anterior',
      'Search failed(search dialog)': 'La búsqueda falló',
      'Search failed, showing results for {query}(search dialog)':
        'La búsqueda falló; resultados para {query}',
      'Search(search dialog)': 'Buscar',
      'Search(search trigger)': 'Buscar',
      'Show Sidebar(sidebar)': 'Mostrar barra lateral',
      'System(theme switcher)(aria-label)': 'Sistema',
      'Table of Contents(inline table of contents)': 'Índice',
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
        'La página que buscas puede haber sido eliminada, haber cambiado de nombre o no estar disponible temporalmente.',
      'Toggle Menu(mobile menu)(aria-label)': 'Abrir o cerrar menú',
      'Toggle Theme(theme switcher)(aria-label)': 'Cambiar tema',
      'View as Markdown(page actions)': 'Ver como Markdown',
    },
  });

/** Site strings outside Fumadocs' own chrome: nav links, landing page. */
export const siteText: Record<
  Locale,
  {
    docs: string;
    steam: string;
    tagline: string;
    pitch: string;
    readDocs: string;
    buySteam: string;
    demoNote: string;
    sourceNote: string;
    platforms: string;
    features: { idx: string; title: string; body: string }[];
  }
> = {
  en: {
    docs: 'Docs',
    steam: 'Steam',
    tagline: '3D avatar software',
    pitch:
      'A webcam VTuber app: load a VRM avatar and drive its face, body and hands live from an ordinary webcam.',
    readDocs: 'Read the docs',
    buySteam: 'Get it on Steam',
    demoNote: 'Free demo: fully featured for 100 hours of use.',
    sourceNote: 'Open source (MIT)',
    platforms: 'macOS · Windows · Linux',
    features: [
      { idx: '01', title: 'Tracking', body: '52 ARKit blendshapes, head and gaze, upper body and all ten fingers from one webcam.' },
      { idx: '02', title: 'Perfect sync', body: 'Models with ARKit-named expressions are driven 1:1; others get the VRM presets.' },
      { idx: '03', title: 'Virtual camera', body: 'Shows up as VPuppet Virtual Camera in Zoom, Meet, Discord, FaceTime and OBS.' },
      { idx: '04', title: 'VMC out', body: 'Bones and blendshapes over the VMC protocol to VSeeFace, Warudo, VNyan and others.' },
      { idx: '05', title: 'Cloth & hair', body: 'A bone-cloth solver over the model’s own spring bones, with colliders fitted to the body.' },
      { idx: '06', title: 'Motion', body: 'Idle loops, emotes and your own FBX / glTF clips, on keyboard, gamepad or gestures.' },
    ],
  },
  ru: {
    docs: 'Документация',
    steam: 'Steam',
    tagline: 'Программа для 3D-аватаров',
    pitch:
      'Приложение для VTuber с веб-камерой: загрузите VRM-аватар и управляйте его лицом, телом и руками в реальном времени с обычной веб-камеры.',
    readDocs: 'Документация',
    buySteam: 'Купить в Steam',
    demoNote: 'Бесплатная демоверсия: все функции на 100 часов использования.',
    sourceNote: 'Открытый исходный код (MIT)',
    platforms: 'macOS · Windows · Linux',
    features: [
      { idx: '01', title: 'Трекинг', body: '52 блендшейпа ARKit, голова и взгляд, верхняя часть тела и все десять пальцев с одной веб-камеры.' },
      { idx: '02', title: 'Perfect sync', body: 'Модели с выражениями под именами ARKit управляются 1:1, остальные — через пресеты VRM.' },
      { idx: '03', title: 'Виртуальная камера', body: 'Видна как VPuppet Virtual Camera в Zoom, Meet, Discord, FaceTime и OBS.' },
      { idx: '04', title: 'Вывод VMC', body: 'Кости и блендшейпы по протоколу VMC в VSeeFace, Warudo, VNyan и другие программы.' },
      { idx: '05', title: 'Ткань и волосы', body: 'Решатель ткани на собственных spring bones модели с коллайдерами, подогнанными под тело.' },
      { idx: '06', title: 'Анимации', body: 'Idle-циклы, эмоции и ваши клипы FBX / glTF — с клавиатуры, геймпада или жестами.' },
    ],
  },
  'zh-CN': {
    docs: '文档',
    steam: 'Steam',
    tagline: '3D 虚拟形象软件',
    pitch: '一款网络摄像头 VTuber 应用：加载 VRM 模型，用普通网络摄像头实时驱动它的面部、身体和双手。',
    readDocs: '阅读文档',
    buySteam: '在 Steam 上购买',
    demoNote: '免费试用版：全部功能可使用 100 小时。',
    sourceNote: '开源（MIT）',
    platforms: 'macOS · Windows · Linux',
    features: [
      { idx: '01', title: '追踪', body: '一个摄像头即可追踪 52 个 ARKit 混合形状、头部与视线、上半身和全部十根手指。' },
      { idx: '02', title: 'Perfect sync', body: '带有 ARKit 命名表情的模型 1:1 驱动；其他模型使用 VRM 预设表情。' },
      { idx: '03', title: '虚拟摄像头', body: '在 Zoom、Meet、Discord、FaceTime 和 OBS 中显示为 VPuppet Virtual Camera。' },
      { idx: '04', title: 'VMC 输出', body: '通过 VMC 协议把骨骼和混合形状发送到 VSeeFace、Warudo、VNyan 等软件。' },
      { idx: '05', title: '布料与头发', body: '基于模型自带弹簧骨骼的骨骼布料解算，碰撞体贴合身体生成。' },
      { idx: '06', title: '动作', body: '待机循环、表情动作以及你自己的 FBX / glTF 片段，可用键盘、手柄或手势触发。' },
    ],
  },
  es: {
    docs: 'Documentación',
    steam: 'Steam',
    tagline: 'Software de avatares 3D',
    pitch:
      'Una app de VTuber con webcam: carga un avatar VRM y mueve su cara, su cuerpo y sus manos en directo con una webcam normal.',
    readDocs: 'Leer la documentación',
    buySteam: 'Comprar en Steam',
    demoNote: 'Demo gratuita: todas las funciones durante 100 horas de uso.',
    sourceNote: 'Código abierto (MIT)',
    platforms: 'macOS · Windows · Linux',
    features: [
      { idx: '01', title: 'Seguimiento', body: '52 blendshapes de ARKit, cabeza y mirada, torso y los diez dedos con una sola webcam.' },
      { idx: '02', title: 'Perfect sync', body: 'Los modelos con expresiones con nombres de ARKit se controlan 1:1; los demás, con los presets de VRM.' },
      { idx: '03', title: 'Cámara virtual', body: 'Aparece como VPuppet Virtual Camera en Zoom, Meet, Discord, FaceTime y OBS.' },
      { idx: '04', title: 'Salida VMC', body: 'Huesos y blendshapes por el protocolo VMC hacia VSeeFace, Warudo, VNyan y otros.' },
      { idx: '05', title: 'Ropa y pelo', body: 'Un solver de tela sobre los spring bones del propio modelo, con colisionadores ajustados al cuerpo.' },
      { idx: '06', title: 'Movimiento', body: 'Loops de reposo, emotes y tus propios clips FBX / glTF, con teclado, mando o gestos.' },
    ],
  },
};

export function baseOptions(locale: Locale): BaseLayoutProps {
  const t = siteText[locale];
  return {
    nav: {
      title: <Logo />,
      url: `/${locale}/`,
    },
    githubUrl,
    links: [
      { text: t.docs, url: `/${locale}/docs/`, active: 'nested-url' },
      { text: t.steam, url: steamUrl, external: true },
    ],
  };
}
