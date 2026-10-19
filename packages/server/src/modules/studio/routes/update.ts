import Router from '@koa/router'
import * as ctrl from '../controllers/update'
import { requireSuperAdmin } from '../middleware/super-admin'

export const updateRoutes = new Router()

// Fork: the update endpoint installs `npm i -g <pkg>@latest` and restarts the
// service, so it must never be reachable by an ordinary logged-in user. Upstream
// shipped this route without any guard while every sibling preview route below
// requires a super admin; on 2026-10-03 that let any user trigger an in-place
// upgrade of the production install. Keep the guard in source instead of patching
// the built bundle, so a rebuild cannot silently drop it.
updateRoutes.post('/api/studio/update', requireSuperAdmin, ctrl.handleUpdate)
updateRoutes.get('/api/studio/update/preview', requireSuperAdmin, ctrl.previewStatus)
updateRoutes.get('/api/studio/update/preview/tags', requireSuperAdmin, ctrl.previewTags)
updateRoutes.post('/api/studio/update/preview/prepare', requireSuperAdmin, ctrl.preparePreview)
updateRoutes.post('/api/studio/update/preview/install', requireSuperAdmin, ctrl.installPreview)
updateRoutes.post('/api/studio/update/preview/start', requireSuperAdmin, ctrl.startPreview)
updateRoutes.post('/api/studio/update/preview/stop', requireSuperAdmin, ctrl.stopPreview)
