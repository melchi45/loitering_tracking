import { Search, Star, Ban, Archive, type LucideIcon } from 'lucide-react';
import type { useI18n } from '../i18n';
import type { GalleryType } from '../types';

export const GALLERY_TYPE_META: Record<GalleryType, { icon: LucideIcon; labelKey: keyof ReturnType<typeof useI18n>['t']; badgeClass: string; rowClass: string }> = {
  missing:  { icon: Search,  labelKey: 'galleryTypeMissing',  badgeClass: 'bg-red-700 text-red-100',     rowClass: 'border-l-red-500' },
  vip:      { icon: Star,    labelKey: 'galleryTypeVip',      badgeClass: 'bg-yellow-700 text-yellow-100', rowClass: 'border-l-yellow-500' },
  blocklist:{ icon: Ban,     labelKey: 'galleryTypeBlocklist', badgeClass: 'bg-orange-700 text-orange-100', rowClass: 'border-l-orange-500' },
  general:  { icon: Archive, labelKey: 'galleryTypeGeneral',  badgeClass: 'bg-gray-700 text-gray-300',    rowClass: 'border-l-blue-500' },
};

export const GALLERY_TYPE_ORDER: GalleryType[] = ['missing', 'vip', 'blocklist', 'general'];
