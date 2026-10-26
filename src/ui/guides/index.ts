import type { ComponentType } from 'react';
import { answersGuide } from './answers';
import { assistantGuide } from './assistant';
import { breaksGuide } from './breaks';
import { kioskGuide } from './kiosk';
import { phoneTagsGuide } from './phoneTags';
import { rotaViewsGuide } from './rotaViews';
import { requestsGuide } from './requests';
import { shiftyGuide } from './shifty';
import { staffAppGuide } from './staffApp';

export interface Guide {
  id: string;
  title: string;
  summary: string;
  Body: ComponentType;
}

/** Everything in How to, in the order it is listed. Add a guide here and it appears in the app. */
export const GUIDES: Guide[] = [shiftyGuide, assistantGuide, rotaViewsGuide, requestsGuide, staffAppGuide, breaksGuide, kioskGuide, phoneTagsGuide, answersGuide];
