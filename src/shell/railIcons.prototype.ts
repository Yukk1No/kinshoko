// PROTOTYPE（订阅入口的图标）：用 `?subs=` 在几种候选间切换，选定后只留一种并删掉这个文件。
// 只在开发服务器里读地址参数；打包后的程序始终是 Rss。
import { Bell, Mailbox, Rss, SatelliteDish, UserRoundCheck } from 'lucide-react';
import { RailInboxIcon, type RailIcon } from './RailIcons';

export const SUBSCRIPTION_ICONS: { id: string; icon: RailIcon; name: string }[] = [
  { id: 'rss', icon: Rss, name: 'Rss 信号波（现在）' },
  { id: 'inbox', icon: RailInboxIcon, name: 'Inbox 收件盘' },
  { id: 'bell', icon: Bell, name: 'Bell 铃铛' },
  { id: 'mailbox', icon: Mailbox, name: 'Mailbox 信箱' },
  { id: 'dish', icon: SatelliteDish, name: 'SatelliteDish 接收天线' },
  { id: 'user', icon: UserRoundCheck, name: 'UserRoundCheck 已关注的人' },
];

const wanted = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('subs') : null;
export const subscriptionIcon = SUBSCRIPTION_ICONS.find((item) => item.id === wanted) ?? SUBSCRIPTION_ICONS[0];

