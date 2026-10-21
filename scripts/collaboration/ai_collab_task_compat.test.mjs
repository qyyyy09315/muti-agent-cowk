import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {attemptRoot,installTaskExecution} from './ai_collab_task_compat.mjs';
test('each lease gets a distinct workspace root and rejects traversal',()=>{
 assert.notEqual(attemptRoot('tasks','run_one'),attemptRoot('tasks','run_two'));
 assert.throws(()=>attemptRoot('tasks','../../main'));
});
test('task context contains peer agreement and Unity validation while preserving acceptance criteria',async()=>{
 let payload,root;
 const runner={config:{taskWorkspaceBaseDir:'old',agentType:'codex'},executePipeline:async()=>{root=runner.config.taskWorkspaceBaseDir},adapter:{executeTask:async p=>{payload=p;return {success:true}}},client:{request:async()=>[{taskId:'task_one',fromAgent:'grok',content:'Spawn_Chengguan'}]},uvcs:{getStatus:async()=>({branch:'/main'}),checkin:async()=>{throw new Error('must not execute')}}};
 installTaskExecution(runner,{taskWorkspaceRoot:'tasks',projectId:'p',unityEditor:'Unity.exe'});
 await runner.executePipeline({}, {id:'run_one'});assert.equal(root,path.join('tasks','attempts','run_one'));assert.equal(runner.config.taskWorkspaceBaseDir,'old');
 await runner.adapter.executeTask({task:{id:'task_one',goal:'build map',acceptanceCriteria:'original acceptance'},workspaceDir:'isolated'});
 assert.match(payload.task.goal,/Spawn_Chengguan/);assert.match(payload.task.goal,/-batchmode/);assert.equal(payload.task.acceptanceCriteria,'original acceptance');
 await assert.rejects(runner.uvcs.checkin('main'),/isolated assigned task branch/);
});
