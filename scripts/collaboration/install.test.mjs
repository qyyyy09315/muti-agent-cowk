import test from 'node:test';
import assert from 'node:assert/strict';
import {installCollaborationRuntime} from './install.mjs';
test('optional installer fails closed without persistent profile, registry verifier or dedicated editable workspace',async()=>{
 await assert.rejects(installCollaborationRuntime({},{}),/profileDir/);
 await assert.rejects(installCollaborationRuntime({},{automaticPeerRoutingEnabled:true},{profileDir:'private-profile'}),/registry verifier/);
 await assert.rejects(installCollaborationRuntime({},{messageEditingEnabled:true},{profileDir:'private-profile'}),/dedicated Unity workspace/);
});
