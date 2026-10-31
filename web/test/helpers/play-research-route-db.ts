import type Database from 'better-sqlite3'
import {setDb,sqliteDb} from '../../lib/db/client.ts'
import type {Role} from '../../lib/workspaces.ts'
let db:Database.Database|null=null,tenant:string|null='A',role:Role='owner'
export function setScanDb(value:Database.Database){db=value;setDb(sqliteDb(value))}
export function getScanDb(){if(!db)throw Error('test database unset');return db}
export function setUser(t:string|null,r:Role='owner'){tenant=t;role=r}
export async function requireUser(){return tenant?{tenantId:tenant,actorId:tenant,role,email:'scratch@example.test',authedAt:Math.floor(Date.now()/1000)}:null}
