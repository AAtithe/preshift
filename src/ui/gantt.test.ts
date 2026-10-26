import { describe, expect, it } from 'vitest';
import { pointAt, slide } from './gantt';

const WEEK = { from: 600, lane: 840, days: 7 }; // 10:00 to 24:00, seven days
const DAY = { from: 600, lane: 840, days: 1 };

describe('gantt geometry', () => {
  it('reads a point across the week as a day and a minute of it', () => {
    expect(pointAt(0, WEEK)).toEqual({ day: 0, minute: 600 });
    expect(pointAt(1 / 7 + 0.5 / 7, WEEK)).toEqual({ day: 1, minute: 1020 });
    // The far edge belongs to the last day, not an eighth.
    expect(pointAt(1, WEEK).day).toBe(6);
    expect(pointAt(0.5, DAY)).toEqual({ day: 0, minute: 1020 });
  });

  it('slides a shift along its day and across into the next', () => {
    expect(slide(2, 660, 60, WEEK)).toEqual({ day: 2, startMinute: 720 });
    // Started 23:00 on Wednesday, moved two hours on: 11:00 on Thursday, an hour into its lane.
    expect(slide(2, 1380, 120, WEEK)).toEqual({ day: 3, startMinute: 660 });
    expect(slide(1, 700, -300, WEEK)).toEqual({ day: 0, startMinute: 1240 });
  });

  it('keeps a shift inside the week, and on one day only moves the time', () => {
    expect(slide(0, 600, -500, WEEK).day).toBe(0);
    expect(slide(6, 1380, 2000, WEEK).day).toBe(6);
    expect(slide(4, 600, 900, DAY)).toEqual({ day: 4, startMinute: 1500 });
  });
});
