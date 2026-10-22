import type { ComponentType } from 'react';
import { answersGuide } from './answers';
import { assistantGuide } from './assistant';
import { breaksGuide } from './breaks';
import { shiftyGuide } from './shifty';

export interface Guide {
  id: string;
  title: string;
  summary: string;
  Body: ComponentType;
}

/** Everything in How to, in the order it is listed. Add a guide here and it appears in the app. */
export const GUIDES: Guide[] = [shiftyGuide, assistantGuide, breaksGuide, answersGuide];
