import Router from '@koa/router'
import * as ctrl from '../controllers/runtime-versions'
import { requireAdmin, requireSuperAdmin } from '../../studio/public/auth'

export const runtimeVersionRoutes = new Router()

// Read-only inventory: "is the agent installed, and which version". ChatPanel
// probes this on an ordinary user action (creating a Hermes session), so gating
// it on super_admin locks every plain admin out of starting a chat -- the client
// can only read a 403 as "runtime missing" and route them to the installer,
// which is itself super_admin-only. Mutating routes below stay super_admin:
// they install, activate, delete and restart the web UI.
runtimeVersionRoutes.get('/api/hermes/runtime-versions', requireAdmin, ctrl.status)
runtimeVersionRoutes.get('/api/hermes/runtime-versions/jobs', requireSuperAdmin, ctrl.jobs)
runtimeVersionRoutes.get('/api/hermes/runtime-versions/jobs/:id', requireSuperAdmin, ctrl.job)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/active-runtime', requireSuperAdmin, ctrl.activateRuntime)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/runtime-root', requireSuperAdmin, ctrl.selectRuntimeRoot)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/active-webui', requireSuperAdmin, ctrl.activateWebUi)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/runtime/download', requireSuperAdmin, ctrl.downloadRuntime)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/restart-webui', requireSuperAdmin, ctrl.restartWebUi)
runtimeVersionRoutes.post('/api/hermes/runtime-versions/webui/download', requireSuperAdmin, ctrl.downloadWebUi)
runtimeVersionRoutes.delete('/api/hermes/runtime-versions/runtime/:version', requireSuperAdmin, ctrl.deleteRuntime)
runtimeVersionRoutes.delete('/api/hermes/runtime-versions/webui/:version', requireSuperAdmin, ctrl.deleteWebUi)
