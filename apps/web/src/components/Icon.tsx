import type { CSSProperties } from 'react';
import Activity from '@carbon/icons-react/es/Activity';
import WarningAltFilled from '@carbon/icons-react/es/WarningAltFilled';
import ArrowDown from '@carbon/icons-react/es/ArrowDown';
import ArrowUp from '@carbon/icons-react/es/ArrowUp';
import Book from '@carbon/icons-react/es/Book';
import Chemistry from '@carbon/icons-react/es/Chemistry';
import Lightning from '@carbon/icons-react/es/Lightning';
import Checkmark from '@carbon/icons-react/es/Checkmark';
import CheckmarkOutline from '@carbon/icons-react/es/CheckmarkOutline';
import ChevronDown from '@carbon/icons-react/es/ChevronDown';
import ChevronLeft from '@carbon/icons-react/es/ChevronLeft';
import ChevronRight from '@carbon/icons-react/es/ChevronRight';
import ChevronUp from '@carbon/icons-react/es/ChevronUp';
import DotMark from '@carbon/icons-react/es/DotMark';
import Time from '@carbon/icons-react/es/Time';
import Code from '@carbon/icons-react/es/Code';
import Copy from '@carbon/icons-react/es/Copy';
import DataBase from '@carbon/icons-react/es/DataBase';
import Download from '@carbon/icons-react/es/Download';
import Edit from '@carbon/icons-react/es/Edit';
import Launch from '@carbon/icons-react/es/Launch';
import View from '@carbon/icons-react/es/View';
import ViewOff from '@carbon/icons-react/es/ViewOff';
import Document from '@carbon/icons-react/es/Document';
import Flag from '@carbon/icons-react/es/Flag';
import Branch from '@carbon/icons-react/es/Branch';
import Draggable from '@carbon/icons-react/es/Draggable';
import Layers from '@carbon/icons-react/es/Layers';
import List from '@carbon/icons-react/es/List';
import Task from '@carbon/icons-react/es/Task';
import Renew from '@carbon/icons-react/es/Renew';
import Logout from '@carbon/icons-react/es/Logout';
import Maximize from '@carbon/icons-react/es/Maximize';
import Minimize from '@carbon/icons-react/es/Minimize';
import Chat from '@carbon/icons-react/es/Chat';
import Asleep from '@carbon/icons-react/es/Asleep';
import Light from '@carbon/icons-react/es/Light';
import OverflowMenuHorizontal from '@carbon/icons-react/es/OverflowMenuHorizontal';
import SidePanelOpen from '@carbon/icons-react/es/SidePanelOpen';
import Pause from '@carbon/icons-react/es/Pause';
import Play from '@carbon/icons-react/es/Play';
import Add from '@carbon/icons-react/es/Add';
import Save from '@carbon/icons-react/es/Save';
import Search from '@carbon/icons-react/es/Search';
import SendAlt from '@carbon/icons-react/es/SendAlt';
import Settings from '@carbon/icons-react/es/Settings';
import MagicWand from '@carbon/icons-react/es/MagicWand';
import Star from '@carbon/icons-react/es/Star';
import Split from '@carbon/icons-react/es/Split';
import Table from '@carbon/icons-react/es/Table';
import Tag from '@carbon/icons-react/es/Tag';
import Terminal from '@carbon/icons-react/es/Terminal';
import TrashCan from '@carbon/icons-react/es/TrashCan';
import Upload from '@carbon/icons-react/es/Upload';
import User from '@carbon/icons-react/es/User';
import WarningAlt from '@carbon/icons-react/es/WarningAlt';
import Close from '@carbon/icons-react/es/Close';
import Globe from '@carbon/icons-react/es/Globe';

import type { CarbonIconType } from '@carbon/icons-react/es/CarbonIcon';

// 与 CRM 对齐：IBM Carbon 图标注册表。调用点 API（<Icon name size className style />）不变，
// 仅替换实现；Carbon 图标 fill=currentColor，size 走 width/height。

const iconMap: Record<string, CarbonIconType> = {
  activity: Activity,
  alertCircle: WarningAltFilled,
  arrowDown: ArrowDown,
  arrowUp: ArrowUp,
  bookOpen: Book,
  beaker: Chemistry,
  bolt: Lightning,
  check: Checkmark,
  checkCircle: CheckmarkOutline,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  circleDot: DotMark,
  clock: Time,
  code: Code,
  copy: Copy,
  database: DataBase,
  table: Table,
  download: Download,
  edit: Edit,
  exclamationCircle: WarningAltFilled,
  externalLink: Launch,
  eye: View,
  eyeOff: ViewOff,
  file: Document,
  flag: Flag,
  gitBranch: Branch,
  globe: Globe,
  gripVertical: Draggable,
  layers: Layers,
  list: List,
  listChecks: Task,
  loader: Renew,
  logOut: Logout,
  maximize: Maximize,
  message: Chat,
  minimize: Minimize,
  moon: Asleep,
  moreHorizontal: OverflowMenuHorizontal,
  panelLeft: SidePanelOpen,
  pause: Pause,
  pencil: Edit,
  play: Play,
  plus: Add,
  refresh: Renew,
  save: Save,
  search: Search,
  send: SendAlt,
  settings: Settings,
  sparkles: MagicWand,
  split: Split,
  star: Star,
  sun: Light,
  tag: Tag,
  terminal: Terminal,
  trash: TrashCan,
  upload: Upload,
  user: User,
  warning: WarningAlt,
  close: Close,
};

export type IconName = keyof typeof iconMap;

interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export default function Icon({ name, ...props }: { name: IconName } & IconProps) {
  const CarbonIcon = iconMap[name];
  if (!CarbonIcon) return null;
  return <CarbonIcon aria-hidden focusable={false} {...props} />;
}
