import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, getInitialState } from '@/store/store';

const s = () => useStore.getState();
const node = (id: string) => s().nodes.find((n) => n.id === id);
/** the store's own picker/Site-Map rule: only published locations are ever offered/shown */
const shared = () => s().nodes.filter((n) => !n.draft);

beforeEach(() => {
  useStore.setState(getInitialState());
});

describe('draft → publish lifecycle (locations)', () => {
  it('a draft location is private WIP: present in the tree but flagged draft', () => {
    expect(node('z-basement')?.draft).toBe(true); // the seeded work-in-progress zone
    expect(node('r-cellar')?.draft).toBe(true); //   …and its room
  });

  it('a draft location is hidden from the shared surfaces (Site Map + filing pickers)', () => {
    // both the Site Map and the LocationPicker read `nodes.filter(n => !n.draft)`
    expect(shared().some((n) => n.id === 'z-basement')).toBe(false);
    expect(shared().some((n) => n.id === 'r-cellar')).toBe(false);
    // the published tree is still there
    expect(shared().some((n) => n.id === 'z-gf')).toBe(true);
  });

  it('publishing a draft zone reveals its whole subtree at once + notifies', () => {
    const notifBefore = s().notifications.length;

    s().publishNode('z-basement');

    expect(node('z-basement')?.draft).toBe(false);
    expect(node('r-cellar')?.draft).toBe(false); // the room below came along
    // now visible on the shared surfaces
    expect(shared().some((n) => n.id === 'z-basement')).toBe(true);
    expect(shared().some((n) => n.id === 'r-cellar')).toBe(true);
    // the team is told, exactly once
    expect(s().notifications.length).toBe(notifBefore + 1);
    expect(s().notifications[0].text).toContain('Basement');
  });

  it('publishing a draft CHILD also publishes its draft ancestors — no orphan hanging off a hidden parent', () => {
    s().publishNode('r-cellar'); // publish the room, not the zone

    expect(node('r-cellar')?.draft).toBe(false);
    expect(node('z-basement')?.draft).toBe(false); // its still-draft parent was pulled live too
  });

  it('publishing is idempotent: a second publish of the same location is a no-op', () => {
    s().publishNode('z-basement');
    const after = s().notifications.length;
    s().publishNode('z-basement'); // already live
    expect(s().notifications.length).toBe(after);
  });

  it('publishing an already-published location does nothing (guards the whole tree)', () => {
    const notifBefore = s().notifications.length;
    s().publishNode('z-gf'); // never a draft
    expect(s().notifications.length).toBe(notifBefore);
  });
});
