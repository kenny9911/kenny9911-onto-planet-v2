import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword,verifyPassword} from '../src/index.js';
test('password storage uses salted hashes and validates length and secret equality',async()=>{
 const password='fixture-password-42';const first=await hashPassword(password),second=await hashPassword(password);
 assert.notEqual(first,second);assert.ok(!first.includes(password));assert.equal(await verifyPassword(password,first),true);assert.equal(await verifyPassword('wrong password',first),false);
 await assert.rejects(hashPassword('short'),/12 and 256/);assert.equal(await verifyPassword(password,'invalid'),false);
});
