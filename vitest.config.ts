import { configDefaults, defineConfig } from 'vitest/config';
const installedNetwork = 'tests/unit/lima-installed-network.test.ts';
const workers = 'tests/unit/workers.test.ts';
const coordinatorNetwork = 'tests/integration/lima-installed-network.test.ts';
export default defineConfig({test:{
 testTimeout:15000,
 coverage:{provider:'v8',include:['src/**/*.ts'],exclude:['src/web/**','src/index.ts','src/mcp.ts']},
 projects:[
  {extends:true,test:{name:'workers',include:[workers],sequence:{groupOrder:0}}},
  {extends:true,test:{name:'coordinator-network',include:[coordinatorNetwork],sequence:{groupOrder:1}}},
  {extends:true,test:{name:'core',include:['tests/unit/**/*.test.ts','tests/integration/**/*.test.ts'],exclude:[...configDefaults.exclude,installedNetwork,workers,coordinatorNetwork],sequence:{groupOrder:2}}},
  {extends:true,test:{name:'lima-network',include:[installedNetwork],sequence:{groupOrder:3}}},
 ]
}});
