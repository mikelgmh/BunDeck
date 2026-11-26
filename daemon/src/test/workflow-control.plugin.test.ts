import { describe, expect, it } from 'bun:test'
import { validateManifest } from '../plugin-system/validator'
import { ClipboardPlugin } from '../plugins/clipboard.plugin'
import { FlowControlPlugin } from '../plugins/flow-control.plugin'
import { MidiOscPlugin } from '../plugins/midi-osc.plugin'
import { PagePlugin } from '../plugins/page.plugin'
import { ProfileAutoPlugin } from '../plugins/profile-auto.plugin'
import { WindowManagerPlugin } from '../plugins/window-manager.plugin'

const context = {
  log: () => {},
  getSetting: () => null,
  setSetting: () => {},
  deleteSetting: () => {},
}

function actionsOf(manifest: any): Map<string, any> {
  return new Map(manifest.actions.map((action: any) => [action.id, action]))
}

describe('workflow-control metadata on native plugins', () => {
  const manifests = [
    new ClipboardPlugin(context).getManifest(),
    new FlowControlPlugin(context).getManifest(),
    new ProfileAutoPlugin(context).getManifest(),
    new PagePlugin(context).getManifest(),
    new WindowManagerPlugin(context).getManifest(),
    new MidiOscPlugin(context).getManifest(),
  ]

  it('marks only the first-party workflow controls for free mode', () => {
    const controls = manifests.flatMap((manifest: any) =>
      manifest.actions
        .filter((action: any) => action.surface === 'control')
        .map((action: any) => `${manifest.id}.${action.id}`),
    ).sort()

    expect(controls).toEqual([
      'clipboard.history',
      'clipboard.list-slots',
      'clipboard.paste-slot',
      'clipboard.save-slot',
      'flow.get-var',
      'flow.set-var',
      'flow.toggle-var',
      'midi-osc.send-osc',
      'page.page',
      'profile-auto.status',
      'profile-auto.switch-profile',
      'window-manager.layout-list',
    ])
    for (const manifest of manifests) {
      expect(validateManifest(manifest).errors).toEqual([])
      for (const action of manifest.actions.filter((a: any) => a.surface === 'control')) {
        expect(action).toMatchObject({
          component: 'workflow-control',
          freeModeOnly: true,
        })
      }
    }
  })

  it('leaves destructive, unsupported, and simple utility actions as ordinary buttons', () => {
    const clipboard = actionsOf(manifests[0])
    const flow = actionsOf(manifests[1])
    const profile = actionsOf(manifests[2])
    const windows = actionsOf(manifests[4])
    const midi = actionsOf(manifests[5])

    expect(clipboard.get('save-slot')).toMatchObject({ surface: 'control', component: 'workflow-control', freeModeOnly: true })
    expect(clipboard.get('paste-slot')).toMatchObject({ surface: 'control', component: 'workflow-control', freeModeOnly: true })
    expect(clipboard.get('history')).toMatchObject({ surface: 'control', component: 'workflow-control', freeModeOnly: true })
    expect(flow.get('wait').surface).toBeUndefined()
    expect(flow.get('log').surface).toBeUndefined()
    expect(profile.get('remove-rule').surface).toBeUndefined()
    expect(profile.get('set-enabled').surface).toBeUndefined()
    expect(windows.get('window-action').surface).toBeUndefined()
    expect(windows.get('layout-restore').surface).toBeUndefined()
    expect(windows.get('layout-save').surface).toBeUndefined()
    expect(midi.get('send-midi').surface).toBeUndefined()
  })
})
