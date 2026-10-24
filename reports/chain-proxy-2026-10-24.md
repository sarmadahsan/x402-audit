# Chain proxy floors (eip155:8453)

- Window: blocks 51712495..53008495, 2026-09-24T01:45:37.000Z to 2026-10-24T01:45:37.000Z
- Universe: top 60 pay-to addresses by scanned USDC volume (requested 60), transfers with value >= 100 atomic units (dust floor).
- All non-dust view: 1032368 transfers, $1181377.482229. Includes unverified rows (via_authorization NULL) and plain transfers.
- Verified view: 4263 transfers, $2377.516449. Only rows whose tx has AuthorizationUsed from the same sender (EIP-3009 settlements).
- Duplicate window: 120 s. Intervals: Wilson 95%; dollar-weighted intervals are approximate (Kish effective n).
- Named queries: `chain_proxy_totals`, `chain_proxy_overcharge`, `chain_proxy_duplicate_runs` (src/chain/report.ts).

## Market-wide proxy rates

### Count-weighted

| proxy | all non-dust (n = 1032368) | verified only (n = 4263) |
|---|---|---|
| overcharge proxy: value > mode | 18.06% [17.99%, 18.13%] (186448) | 26.06% [24.77%, 27.40%] (1111) |
| overcharge proxy: value > 2 x mode | 13.47% [13.41%, 13.54%] (139075) | 21.14% [19.94%, 22.39%] (901) |
| duplicate-run followers | 73.39% [73.30%, 73.47%] (757645) | 16.14% [15.07%, 17.27%] (688) |

### Dollar-weighted

| proxy | all non-dust ($1181377.482229) | verified only ($2377.516449) |
|---|---|---|
| overcharge proxy: value > mode | 98.00% [95.17%, 99.18%] ($1157736.909844) | 87.30% [66.47%, 95.97%] ($2075.551037) |
| overcharge proxy: value > 2 x mode | 97.74% [94.82%, 99.03%] ($1154677.555986) | 85.62% [64.51%, 95.13%] ($2035.721355) |
| duplicate-run followers | 1.39% [0.48%, 3.96%] ($16444.048533) | 4.63% [0.77%, 23.27%] ($110.008861) |

Adjusted (verified rows only): overcharge > mode 26.06% [24.77%, 27.40%], > 2 x mode 21.14% [19.94%, 22.39%], duplicate 16.14% [15.07%, 17.27%] (count-weighted, n = 4263).

### EIP-3009 share (sampled receipts)

| pay-to | sampled txs | via AuthorizationUsed | share [95% CI] | population |
|---|---|---|---|---|
| 0x480cd46e6fade651a0437deadda53d5c8e7d846a | 100 | 15 | 15.00% [9.31%, 23.28%] | 5032 |
| 0x1caa1962428382106eb3f29b9719bdf797621c90 | 61 | 5 | 8.20% [3.55%, 17.79%] | 61 |
| 0x0f99fc0cbd7a114b2da171fda5a0167858f7afc2 | 100 | 32 | 32.00% [23.67%, 41.66%] | 36864 |
| 0xd85096faec1ac03075667b4c1a1661f5623bf111 | 50 | 8 | 16.00% [8.34%, 28.51%] | 50 |
| 0x47d3394c7234714e4b9e9b74827c12be847f9dda | 100 | 100 | 100.00% [96.30%, 100.00%] | 16664 |
| 0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37 | 100 | 67 | 67.00% [57.31%, 75.44%] | 251 |
| 0x7284d41b5b852f2bd4c99bdf95043d84452d299c | 100 | 100 | 100.00% [96.30%, 100.00%] | 443519 |
| 0x589a2314a2e05f45e40c4823da3ba58d421db3d8 | 100 | 100 | 100.00% [96.30%, 100.00%] | 63323 |
| 0x8b29dabd6fbb5a09dacbc7978eaed66a8540721d | 100 | 25 | 25.00% [17.55%, 34.30%] | 124 |
| 0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f | 100 | 99 | 99.00% [94.55%, 99.82%] | 4945 |
| 0xf121fbecec43e1b616d47285851c20d5fc64431b | 100 | 98 | 98.00% [93.00%, 99.45%] | 283 |
| 0x98886846918c7debe86e1d74e249dcdd64a9d367 | 100 | 100 | 100.00% [96.30%, 100.00%] | 4699 |
| 0xe813d34c0525e0fbb1e6478b86d40b83603c2008 | 100 | 99 | 99.00% [94.55%, 99.82%] | 1335 |
| 0x213c8d7434e2ae7aa1c392767c5120778d413215 | 100 | 72 | 72.00% [62.51%, 79.86%] | 650 |
| 0x21f4a2da07bcce60878cab223358d11ad8f11a94 | 100 | 91 | 91.00% [83.77%, 95.19%] | 121 |
| 0xdcdf184a64f6489ec5304750a0af157440115cae | 100 | 91 | 91.00% [83.77%, 95.19%] | 207 |
| 0x8ebf296c6273760ed9604c428f7ec13255e46fb9 | 85 | 67 | 78.82% [68.99%, 86.16%] | 85 |
| 0x702ba46435d1e55b18440100bc81eb055574875e | 25 | 7 | 28.00% [14.28%, 47.58%] | 25 |
| 0xe9030014f5dae217d0a152f02a043567b16c1abf | 100 | 100 | 100.00% [96.30%, 100.00%] | 102582 |
| 0x17cd53c04d707ef0dd615ef56c633f02915a7905 | 100 | 100 | 100.00% [96.30%, 100.00%] | 29239 |
| 0x159be9e316bc5fac8ce05aec4eaae46e8f8a4908 | 100 | 100 | 100.00% [96.30%, 100.00%] | 12193 |
| 0xb4a9238c9400a7f1bb7924606ff2ea634a0f3ec4 | 4 | 1 | 25.00% [4.56%, 69.94%] | 4 |
| 0x325bdf6f7efab24a2210c48c1b64cab2eae1d430 | 100 | 100 | 100.00% [96.30%, 100.00%] | 45810 |
| 0x0d083590c048a243e24a75e3a7c968145de25b44 | 100 | 100 | 100.00% [96.30%, 100.00%] | 742 |
| 0x26572ff23c6c52bfb1a69cb0c9114a8be443b422 | 100 | 100 | 100.00% [96.30%, 100.00%] | 298 |
| 0x9deebb5d1b22e4a6e027977cead13893a7e4cc1a | 69 | 12 | 17.39% [10.24%, 27.98%] | 69 |
| 0x1937e2d648b8f07a03429ae35f28c4942a756c94 | 20 | 13 | 65.00% [43.29%, 81.88%] | 20 |
| 0x4aabe17c239ef71c3a26ba7c2b3e0aebbfc1df26 | 100 | 54 | 54.00% [44.26%, 63.44%] | 374 |
| 0xd5ba9711a3d052846a3695c70e7fcb8b3168fe7d | 100 | 99 | 99.00% [94.55%, 99.82%] | 7943 |
| 0x6cab485fc28ec70d3845113b704d4824e4d2b24f | 20 | 18 | 90.00% [69.90%, 97.21%] | 20 |
| 0x348df429bd49a7506128c74ce1124a81b4b7dc9d | 100 | 99 | 99.00% [94.55%, 99.82%] | 107 |
| 0x8bc2aecdd86097f74a1a5fa17764108d9a683c8c | 100 | 100 | 100.00% [96.30%, 100.00%] | 48718 |
| 0x617da9383fba67e86137bc4924b8b7e400fb7c9e | 59 | 59 | 100.00% [93.89%, 100.00%] | 59 |
| 0x9fb365e4e9385e2a39febad70368267e6f571d9a | 100 | 100 | 100.00% [96.30%, 100.00%] | 42225 |
| 0xbd62f8dcb52e21ca5bdf20ba173488da101ebcf0 | 100 | 24 | 24.00% [16.69%, 33.23%] | 660 |
| 0x8e57bfde053dbb6862991759c19affc5f383d5d0 | 66 | 65 | 98.48% [91.90%, 99.73%] | 66 |
| 0xf732ea490c5766071785a2310523f7fa2cebb829 | 100 | 100 | 100.00% [96.30%, 100.00%] | 56854 |
| 0x2e8dfc2a77adcdd865a46293844c250462a1c32d | 100 | 10 | 10.00% [5.52%, 17.44%] | 1470 |
| 0x158e90dd58fbe897ed8c244f472febee37283d00 | 100 | 100 | 100.00% [96.30%, 100.00%] | 23122 |
| 0x338d8649efa45b940d6656030faa58d9d01e6983 | 20 | 17 | 85.00% [63.96%, 94.76%] | 20 |
| 0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0 | 100 | 100 | 100.00% [96.30%, 100.00%] | 12967 |
| 0x7f985b1764f79faa42a4622bb605b23c8eb5abea | 32 | 30 | 93.75% [79.85%, 98.27%] | 32 |
| 0x66d7c2f952362bfb24fd7f02a9bec9c754ea83bc | 100 | 100 | 100.00% [96.30%, 100.00%] | 4474 |
| 0xdd350976b8cffc65938c0464d39a2c78be079bd0 | 100 | 100 | 100.00% [96.30%, 100.00%] | 128 |
| 0x788b4ca11950879550353d8ae82d1c0af6018454 | 100 | 100 | 100.00% [96.30%, 100.00%] | 705 |
| 0x50ab2018c06c6e4eaa9ba52057eb55ed284912fc | 100 | 100 | 100.00% [96.30%, 100.00%] | 1455 |
| 0x3f60008dfd0efc03f476d9b489d6c5b13b3ebf2c | 100 | 100 | 100.00% [96.30%, 100.00%] | 1138 |
| 0x96368628b679a459fe69815bacca5cb0232ac397 | 100 | 100 | 100.00% [96.30%, 100.00%] | 23193 |
| 0x5b32c973596078a967562ca652761404f19be0e9 | 100 | 98 | 98.00% [93.00%, 99.45%] | 221 |
| 0x6c0752c09e7f6fa6526fcdf40e456a159ebb5621 | 100 | 100 | 100.00% [96.30%, 100.00%] | 7777 |
| 0xb92bb76e3c5575160a2a561913047727d33af9a6 | 47 | 45 | 95.74% [85.75%, 98.83%] | 47 |
| 0xd494a454888a390b2b05df74ae2b5fd9c9902b71 | 100 | 100 | 100.00% [96.30%, 100.00%] | 875 |
| 0xcfa26f13c6c18307033ece13bbb8f470da5b4dbe | 100 | 100 | 100.00% [96.30%, 100.00%] | 3132 |
| 0x837c40e2b4e976f43ffb4451ee281a00fa9477dd | 100 | 100 | 100.00% [96.30%, 100.00%] | 712 |
| 0x4842a7d5b2553f4385d5e8d0cf1b94a10b99dba7 | 100 | 97 | 97.00% [91.55%, 98.97%] | 136 |
| 0x942bd3e3073543c674efc0c378d5bce20f9120c1 | 100 | 100 | 100.00% [96.30%, 100.00%] | 527 |
| 0xc141cbe4f4a9cabc3cc78159a9268a4e008922cd | 100 | 0 | 0.00% [0.00%, 3.70%] | 440 |
| 0x8836b033566cc871b069c90c38bbde5c03182c33 | 44 | 41 | 93.18% [81.77%, 97.65%] | 44 |
| 0x6d6e695b09861467c7d462f5aaf31cf3540b9192 | 100 | 100 | 100.00% [96.30%, 100.00%] | 23446 |
| 0x812db9b2691a457b67eb72f6b76a7fb4413d33f7 | 20 | 5 | 25.00% [11.19%, 46.87%] | 20 |

## Per pay-to (all non-dust view)

| # | pay-to | sellers | transfers | USDC | mode price | > mode n (%) | dup followers n (%) | verified rows | EIP-3009 share [lo, hi] |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0x480cd46e6fade651a0437deadda53d5c8e7d846a | api.bitrefill.com | 5032 | $607445.877402 | $0.002000 | 4343 (86.31%) | 216 (4.29%) | 15 | 15.00% [9.31%, 23.28%] (n = 100) |
| 2 | 0x1caa1962428382106eb3f29b9719bdf797621c90 | api.vapinetwork.ai | 79 | $256554.875829 | $0.002000 | 74 (93.67%) | 1 (1.27%) | 5 | 8.20% [3.55%, 17.79%] (n = 61) |
| 3 | 0x0f99fc0cbd7a114b2da171fda5a0167858f7afc2 | api.surplusintelligence.ai | 36864 | $136235.441000 | $0.003347 | 36050 (97.79%) | 418 (1.13%) | 32 | 32.00% [23.67%, 41.66%] (n = 100) |
| 4 | 0xd85096faec1ac03075667b4c1a1661f5623bf111 | api.slamai.dev, slamlink-ai-main-50fbb45.d2.zuplo.dev | 60 | $40682.147019 | $0.001000 | 51 (85.00%) | 1 (1.67%) | 8 | 16.00% [8.34%, 28.51%] (n = 50) |
| 5 | 0x47d3394c7234714e4b9e9b74827c12be847f9dda | x402.dtelecom.org | 16664 | $36596.200200 | $1.000000 | 6577 (39.47%) | 1 (0.01%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 6 | 0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37 | laso.finance, x402endpoint-utiwoa54hq-uc.a.run.app | 252 | $34680.733340 | $0.001000 | 141 (55.95%) | 29 (11.51%) | 67 | 67.00% [57.31%, 75.44%] (n = 100) |
| 7 | 0x7284d41b5b852f2bd4c99bdf95043d84452d299c | ax1-new.vercel.app, ax1.vc | 443519 | $8870.380000 | $0.020000 | 0 (0.00%) | 420527 (94.82%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 8 | 0x589a2314a2e05f45e40c4823da3ba58d421db3d8 | api-xpay.com | 63323 | $8773.645000 | $0.005000 | 754 (1.19%) | 61871 (97.71%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 9 | 0x8b29dabd6fbb5a09dacbc7978eaed66a8540721d | x402.clashofcoins.com | 124 | $6906.444368 | $0.010382 | 78 (62.90%) | 2 (1.61%) | 25 | 25.00% [17.55%, 34.30%] (n = 100) |
| 10 | 0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f | api.nansen.ai | 4945 | $4436.416000 | $0.010000 | 1358 (27.46%) | 2961 (59.88%) | 99 | 99.00% [94.55%, 99.82%] (n = 100) |
| 11 | 0xf121fbecec43e1b616d47285851c20d5fc64431b | api.boonprotocol.com, api.locus.report, locus.report | 283 | $4205.340802 | $0.010000 | 85 (30.04%) | 171 (60.42%) | 98 | 98.00% [93.00%, 99.45%] (n = 100) |
| 12 | 0x98886846918c7debe86e1d74e249dcdd64a9d367 | api.gondola-ai.com | 4699 | $3354.227440 | $0.010000 | 1465 (31.18%) | 2757 (58.67%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 13 | 0xe813d34c0525e0fbb1e6478b86d40b83603c2008 | jev-systemone.vercel.app, jev-x402-evil.vercel.app, jev-x402.vercel.app | 1336 | $3028.123242 | $0.001000 | 25 (1.87%) | 1291 (96.63%) | 99 | 99.00% [94.55%, 99.82%] (n = 100) |
| 14 | 0x213c8d7434e2ae7aa1c392767c5120778d413215 | cheaptokens.ai | 650 | $2656.626449 | $1.000000 | 223 (34.31%) | 76 (11.69%) | 72 | 72.00% [62.51%, 79.86%] (n = 100) |
| 15 | 0x21f4a2da07bcce60878cab223358d11ad8f11a94 | intel.degenscan.io | 121 | $2063.711611 | $0.001000 | 82 (67.77%) | 44 (36.36%) | 91 | 91.00% [83.77%, 95.19%] (n = 100) |
| 16 | 0xdcdf184a64f6489ec5304750a0af157440115cae | api.ai-open-models.com | 207 | $2056.101141 | $0.002000 | 74 (35.75%) | 85 (41.06%) | 91 | 91.00% [83.77%, 95.19%] (n = 100) |
| 17 | 0x8ebf296c6273760ed9604c428f7ec13255e46fb9 | solene-fa2010da.base44.app | 85 | $1630.320334 | $0.020000 | 54 (63.53%) | 25 (29.41%) | 67 | 78.82% [68.99%, 86.16%] (n = 85) |
| 18 | 0x702ba46435d1e55b18440100bc81eb055574875e | gamemaxxing.baes.so | 29 | $1578.184469 | $0.001000 | 22 (75.86%) | 0 (0.00%) | 7 | 28.00% [14.28%, 47.58%] (n = 25) |
| 19 | 0xe9030014f5dae217d0a152f02a043567b16c1abf | blockrun-staging-55a0fab-150415-vbsbhh7lea-uc.a.run.app, blockrun-staging-f151779-235248-vbsbhh7lea-uc.a.run.app, blockrun-web-vbsbhh7lea-uc.a.run.app, blockrun.ai | 102582 | $1528.654773 | $0.002000 | 83324 (81.23%) | 34092 (33.23%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 20 | 0x17cd53c04d707ef0dd615ef56c633f02915a7905 | keyring-agent.blockchhub.link | 29239 | $1461.950000 | $0.050000 | 0 (0.00%) | 1156 (3.95%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 21 | 0x159be9e316bc5fac8ce05aec4eaae46e8f8a4908 | api.botpay.network | 12193 | $1218.380000 | $0.100000 | 0 (0.00%) | 2728 (22.37%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 22 | 0xb4a9238c9400a7f1bb7924606ff2ea634a0f3ec4 | macro-pulse-x402.onrender.com | 4 | $1194.900684 | $0.020000 | 3 (75.00%) | 0 (0.00%) | 1 | 25.00% [4.56%, 69.94%] (n = 4) |
| 23 | 0x325bdf6f7efab24a2210c48c1b64cab2eae1d430 | enrichx402.com, stable-enrich-git-fix-stableenrich-exa-api-schema-merit-systems.vercel.app, stable-enrich-git-mason-migrate-off-prices-map-merit-systems.vercel.app, stable-enrich-git-shafu-stableenrich-peopl-a13b22-merit-systems.vercel.app, stableenrich.dev | 45810 | $1192.526000 | $0.010000 | 21319 (46.54%) | 38844 (84.79%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 24 | 0x0d083590c048a243e24a75e3a7c968145de25b44 | agentcash-fortune-demo-six.vercel.app, base-gas-x402-production.up.railway.app | 742 | $1134.396664 | $0.005000 | 25 (3.37%) | 5 (0.67%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 25 | 0x26572ff23c6c52bfb1a69cb0c9114a8be443b422 | ausca.com, gofrantic.com | 298 | $982.050000 | $0.050000 | 128 (42.95%) | 102 (34.23%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 26 | 0x9deebb5d1b22e4a6e027977cead13893a7e4cc1a | chat-api.memchat.io | 69 | $751.405004 | $10.000000 | 11 (15.94%) | 4 (5.80%) | 12 | 17.39% [10.24%, 27.98%] (n = 69) |
| 27 | 0x1937e2d648b8f07a03429ae35f28c4942a756c94 | api.builtwith.com, website2vat.com | 20 | $612.286532 | $0.049500 | 9 (45.00%) | 0 (0.00%) | 13 | 65.00% [43.29%, 81.88%] (n = 20) |
| 28 | 0x4aabe17c239ef71c3a26ba7c2b3e0aebbfc1df26 | agi.apify.com, api.apify.com | 374 | $596.703281 | $1.000000 | 43 (11.50%) | 110 (29.41%) | 54 | 54.00% [44.26%, 63.44%] (n = 100) |
| 29 | 0xd5ba9711a3d052846a3695c70e7fcb8b3168fe7d | api.losbeto.xyz | 7943 | $572.650014 | $0.010000 | 5794 (72.94%) | 5508 (69.34%) | 99 | 99.00% [94.55%, 99.82%] (n = 100) |
| 30 | 0x6cab485fc28ec70d3845113b704d4824e4d2b24f | x402.miroshark.xyz | 20 | $510.580981 | $1.000000 | 2 (10.00%) | 1 (5.00%) | 18 | 90.00% [69.90%, 97.21%] (n = 20) |
| 31 | 0x348df429bd49a7506128c74ce1124a81b4b7dc9d | api.aurelianflo.com | 107 | $501.068699 | $0.010000 | 1 (0.93%) | 15 (14.02%) | 99 | 99.00% [94.55%, 99.82%] (n = 100) |
| 32 | 0x8bc2aecdd86097f74a1a5fa17764108d9a683c8c | market.datapackvibe.com | 48718 | $495.870000 | $0.010000 | 384 (0.79%) | 46407 (95.26%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 33 | 0x617da9383fba67e86137bc4924b8b7e400fb7c9e | blockchainiq.co | 59 | $458.579437 | $0.020000 | 13 (22.03%) | 18 (30.51%) | 59 | 100.00% [93.89%, 100.00%] (n = 59) |
| 34 | 0x9fb365e4e9385e2a39febad70368267e6f571d9a | win.oneshotagent.com | 42225 | $448.168100 | $0.005000 | 7649 (18.11%) | 39471 (93.48%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 35 | 0xbd62f8dcb52e21ca5bdf20ba173488da101ebcf0 | api.hivemindos.app, hivemindos-paid-agent-gateway.hivemindos.workers.dev | 660 | $426.191645 | $1.000000 | 24 (3.64%) | 134 (20.30%) | 24 | 24.00% [16.69%, 33.23%] (n = 100) |
| 36 | 0x8e57bfde053dbb6862991759c19affc5f383d5d0 | gate402.app, nodeproxy-production.up.railway.app | 66 | $340.529000 | $0.002000 | 17 (25.76%) | 25 (37.88%) | 65 | 98.48% [91.90%, 99.73%] (n = 66) |
| 37 | 0xf732ea490c5766071785a2310523f7fa2cebb829 | agent.pocket.network | 56854 | $284.270000 | $0.005000 | 0 (0.00%) | 18949 (33.33%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 38 | 0x2e8dfc2a77adcdd865a46293844c250462a1c32d | odds.rjhsignaltech.workers.dev | 1470 | $280.989883 | $0.010000 | 242 (16.46%) | 73 (4.97%) | 10 | 10.00% [5.52%, 17.44%] (n = 100) |
| 39 | 0x158e90dd58fbe897ed8c244f472febee37283d00 | agents.chain.link | 23122 | $280.275000 | $0.010000 | 1730 (7.48%) | 15594 (67.44%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 40 | 0x338d8649efa45b940d6656030faa58d9d01e6983 | polymarket-signal-api.pwnker-polymarket-signals.workers.dev | 20 | $262.913239 | $0.001000 | 8 (40.00%) | 0 (0.00%) | 17 | 85.00% [63.96%, 94.76%] (n = 20) |
| 41 | 0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0 | agent402.tools | 12967 | $259.599914 | $0.002000 | 7202 (55.54%) | 8675 (66.90%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 42 | 0x7f985b1764f79faa42a4622bb605b23c8eb5abea | agents.smarterway.tech | 32 | $255.260000 | $0.010000 | 6 (18.75%) | 8 (25.00%) | 30 | 93.75% [79.85%, 98.27%] (n = 32) |
| 43 | 0x66d7c2f952362bfb24fd7f02a9bec9c754ea83bc | api.strale.io | 4474 | $246.294000 | $0.054000 | 482 (10.77%) | 3229 (72.17%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 44 | 0xdd350976b8cffc65938c0464d39a2c78be079bd0 | scvd.store | 128 | $239.584000 | $0.001000 | 84 (65.63%) | 15 (11.72%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 45 | 0x788b4ca11950879550353d8ae82d1c0af6018454 | kari.mayim-mayim.com | 705 | $232.190000 | $0.010000 | 120 (17.02%) | 454 (64.40%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 46 | 0x50ab2018c06c6e4eaa9ba52057eb55ed284912fc | airdroppulse.theaslangroupllc.com, alphapulse.theaslangroupllc.com, api.vetpulse.theaslangroupllc.com, arbipulse.theaslangroupllc.com, autopulse.theaslangroupllc.com, biopulse.theaslangroupllc.com, buildpulse.theaslangroupllc.com, careerpulse.theaslangroupllc.com, chronicapulse.theaslangroupllc.com, citepulse.theaslangroupllc.com, clearcarepulse.theaslangroupllc.com, climatepulse.theaslangroupllc.com, clinicalintelpulse.theaslangroupllc.com, collectablespulse.theaslangroupllc.com, compliancepulse.theaslangroupllc.com, cryptopulse.theaslangroupllc.com, cyberpulse.theaslangroupllc.com, dealpulse.theaslangroupllc.com, debtpulse.theaslangroupllc.com, econsignalpulse.theaslangroupllc.com, edupulse.theaslangroupllc.com, esgpulse.theaslangroupllc.com, fanpulse.theaslangroupllc.com, fieldpulse.theaslangroupllc.com, filingspulse.theaslangroupllc.com, findpulse.theaslangroupllc.com, fitpulse.theaslangroupllc.com, footballpulse.theaslangroupllc.com, franchisepulse.theaslangroupllc.com, gamepulse.theaslangroupllc.com, geopoliticalpulse.theaslangroupllc.com, giftpulse.theaslangroupllc.com, glowpulse.theaslangroupllc.com, govspendpulse.theaslangroupllc.com, grantpulse.theaslangroupllc.com, gridpulse.theaslangroupllc.com, harvestpulse.theaslangroupllc.com, herbapulse.theaslangroupllc.com, homepulse.theaslangroupllc.com, immigrationpulse.theaslangroupllc.com, insurepulse.theaslangroupllc.com, legalpulse.theaslangroupllc.com, longevitypulse.theaslangroupllc.com, macropulse.theaslangroupllc.com, mailpulse.theaslangroupllc.com, marketpulse.theaslangroupllc.com, mealpulse.theaslangroupllc.com, mindpulse.theaslangroupllc.com, nutripulse.theaslangroupllc.com, onchainpulse.theaslangroupllc.com, parentpulse.theaslangroupllc.com, patentpulse.theaslangroupllc.com, petpulse.theaslangroupllc.com, policypulse.theaslangroupllc.com, proppulse.theaslangroupllc.com, prospectpulse.theaslangroupllc.com, pulse.theaslangroupllc.com, racingpulse.theaslangroupllc.com, remittancepulse.theaslangroupllc.com, riskpulse.theaslangroupllc.com, safepulse.theaslangroupllc.com, scentpulse.theaslangroupllc.com, scholarpulse.theaslangroupllc.com, seniorpulse.theaslangroupllc.com, shopperpulse.theaslangroupllc.com, signalpulse.theaslangroupllc.com, stablecoinpulse.theaslangroupllc.com, stateedge.theaslangroupllc.com, tablepulse.theaslangroupllc.com, talentpulse.theaslangroupllc.com, taxpulse.theaslangroupllc.com, tradepulse.theaslangroupllc.com, transitpulse.theaslangroupllc.com, travelpulse.theaslangroupllc.com, truthpulse.theaslangroupllc.com, venturepulse.theaslangroupllc.com, waterpulse.theaslangroupllc.com, wealthpulse.theaslangroupllc.com | 1455 | $225.525000 | $0.100000 | 395 (27.15%) | 1040 (71.48%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 47 | 0x3f60008dfd0efc03f476d9b489d6c5b13b3ebf2c | cloud.trycorpus.ai | 1138 | $224.760000 | $0.010000 | 627 (55.10%) | 78 (6.85%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 48 | 0x96368628b679a459fe69815bacca5cb0232ac397 | api.agents-trust.com | 23193 | $223.175420 | $0.010000 | 6 (0.03%) | 22036 (95.01%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 49 | 0x5b32c973596078a967562ca652761404f19be0e9 | horizonpulse.dev | 221 | $214.797197 | $0.002000 | 164 (74.21%) | 78 (35.29%) | 98 | 98.00% [93.00%, 99.45%] (n = 100) |
| 50 | 0x6c0752c09e7f6fa6526fcdf40e456a159ebb5621 | x402.agentutility.ai | 7777 | $198.783000 | $0.005000 | 4571 (58.78%) | 3894 (50.07%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 51 | 0xb92bb76e3c5575160a2a561913047727d33af9a6 | settled.justinedwardvolmer.workers.dev, settled.tools | 47 | $196.218000 | $0.005000 | 15 (31.91%) | 4 (8.51%) | 45 | 95.74% [85.75%, 98.83%] (n = 47) |
| 52 | 0xd494a454888a390b2b05df74ae2b5fd9c9902b71 | cultos.dev | 875 | $193.061794 | $0.001000 | 254 (29.03%) | 145 (16.57%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 53 | 0xcfa26f13c6c18307033ece13bbb8f470da5b4dbe | stablesocial.dev | 3132 | $187.920000 | $0.060000 | 0 (0.00%) | 2708 (86.46%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 54 | 0x837c40e2b4e976f43ffb4451ee281a00fa9477dd | hubvibe-io.com | 712 | $185.086100 | $0.150000 | 40 (5.62%) | 124 (17.42%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 55 | 0x4842a7d5b2553f4385d5e8d0cf1b94a10b99dba7 | x402.pulsescanner.io | 136 | $179.485350 | $0.003000 | 34 (25.00%) | 108 (79.41%) | 97 | 97.00% [91.55%, 98.97%] (n = 100) |
| 56 | 0x942bd3e3073543c674efc0c378d5bce20f9120c1 | api.arkm.com | 527 | $176.400000 | $0.200000 | 42 (7.97%) | 370 (70.21%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 57 | 0xc141cbe4f4a9cabc3cc78159a9268a4e008922cd | peerlytics.xyz | 472 | $175.854366 | $0.900000 | 56 (11.86%) | 4 (0.85%) | 0 | 0.00% [0.00%, 3.70%] (n = 100) |
| 58 | 0x8836b033566cc871b069c90c38bbde5c03182c33 | fabair-agents.com | 44 | $161.611940 | $2.000000 | 8 (18.18%) | 14 (31.82%) | 41 | 93.18% [81.77%, 97.65%] (n = 44) |
| 59 | 0x6d6e695b09861467c7d462f5aaf31cf3540b9192 | api.aidress.ai, api.exa.ai | 23446 | $160.324000 | $0.007000 | 145 (0.62%) | 20949 (89.35%) | 100 | 100.00% [96.30%, 100.00%] (n = 100) |
| 60 | 0x812db9b2691a457b67eb72f6b76a7fb4413d33f7 | scout-bazaar-api.dimitri-base-eth.chatgpt.site | 20 | $151.417566 | $0.500000 | 15 (75.00%) | 0 (0.00%) | 5 | 25.00% [11.19%, 46.87%] (n = 20) |

## Per pay-to (verified view)

| # | pay-to | transfers | USDC | mode price | > mode n (%) | > 2 x mode n | dup followers n (%) | dup runs |
|---|---|---|---|---|---|---|---|---|
| 1 | 0x480cd46e6fade651a0437deadda53d5c8e7d846a | 15 | $6.392000 | $0.002000 | 2 (13.33%) | 2 | 1 (6.67%) | 1 |
| 2 | 0x1caa1962428382106eb3f29b9719bdf797621c90 | 5 | $0.013000 | $0.002000 | 1 (20.00%) | 1 | 1 (20.00%) | 1 |
| 3 | 0x0f99fc0cbd7a114b2da171fda5a0167858f7afc2 | 32 | $9.608156 | $0.003347 | 30 (93.75%) | 27 | 0 (0.00%) | 0 |
| 4 | 0xd85096faec1ac03075667b4c1a1661f5623bf111 | 8 | $0.008585 | $0.001000 | 1 (12.50%) | 0 | 1 (12.50%) | 1 |
| 5 | 0x47d3394c7234714e4b9e9b74827c12be847f9dda | 100 | $190.500000 | $1.000000 | 40 (40.00%) | 31 | 0 (0.00%) | 0 |
| 6 | 0x3291e96b3bff7ed56e3ca8364273c5b4654b2b37 | 67 | $516.456000 | $0.001000 | 21 (31.34%) | 21 | 10 (14.93%) | 5 |
| 7 | 0x7284d41b5b852f2bd4c99bdf95043d84452d299c | 100 | $2.000000 | $0.020000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 8 | 0x589a2314a2e05f45e40c4823da3ba58d421db3d8 | 100 | $20.490000 | $0.005000 | 2 (2.00%) | 2 | 2 (2.00%) | 2 |
| 9 | 0x8b29dabd6fbb5a09dacbc7978eaed66a8540721d | 25 | $135.839000 | $0.001000 | 14 (56.00%) | 14 | 2 (8.00%) | 2 |
| 10 | 0x93053f1e7a5efeda532fe69cbbe43cbec3a0f13f | 99 | $2.030000 | $0.010000 | 26 (26.26%) | 26 | 5 (5.05%) | 5 |
| 11 | 0xf121fbecec43e1b616d47285851c20d5fc64431b | 98 | $4.990000 | $0.010000 | 31 (31.63%) | 31 | 44 (44.90%) | 14 |
| 12 | 0x98886846918c7debe86e1d74e249dcdd64a9d367 | 100 | $1.958435 | $0.010000 | 33 (33.00%) | 19 | 6 (6.00%) | 6 |
| 13 | 0xe813d34c0525e0fbb1e6478b86d40b83603c2008 | 99 | $0.099000 | $0.001000 | 0 (0.00%) | 0 | 90 (90.91%) | 7 |
| 14 | 0x213c8d7434e2ae7aa1c392767c5120778d413215 | 72 | $86.570000 | $1.000000 | 6 (8.33%) | 4 | 1 (1.39%) | 1 |
| 15 | 0x21f4a2da07bcce60878cab223358d11ad8f11a94 | 91 | $0.769000 | $0.001000 | 58 (63.74%) | 29 | 34 (37.36%) | 16 |
| 16 | 0xdcdf184a64f6489ec5304750a0af157440115cae | 91 | $0.390097 | $0.002000 | 22 (24.18%) | 9 | 30 (32.97%) | 14 |
| 17 | 0x8ebf296c6273760ed9604c428f7ec13255e46fb9 | 67 | $4.720000 | $0.020000 | 36 (53.73%) | 36 | 25 (37.31%) | 13 |
| 18 | 0x702ba46435d1e55b18440100bc81eb055574875e | 7 | $0.007000 | $0.001000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 19 | 0xe9030014f5dae217d0a152f02a043567b16c1abf | 100 | $1.056680 | $0.002000 | 77 (77.00%) | 53 | 0 (0.00%) | 0 |
| 20 | 0x17cd53c04d707ef0dd615ef56c633f02915a7905 | 100 | $5.000000 | $0.050000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 21 | 0x159be9e316bc5fac8ce05aec4eaae46e8f8a4908 | 100 | $9.940000 | $0.100000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 22 | 0xb4a9238c9400a7f1bb7924606ff2ea634a0f3ec4 | 1 | $0.020000 | $0.020000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 23 | 0x325bdf6f7efab24a2210c48c1b64cab2eae1d430 | 100 | $2.460400 | $0.010000 | 51 (51.00%) | 36 | 5 (5.00%) | 5 |
| 24 | 0x0d083590c048a243e24a75e3a7c968145de25b44 | 100 | $0.406000 | $0.005000 | 3 (3.00%) | 1 | 0 (0.00%) | 0 |
| 25 | 0x26572ff23c6c52bfb1a69cb0c9114a8be443b422 | 100 | $244.950000 | $0.050000 | 40 (40.00%) | 40 | 19 (19.00%) | 15 |
| 26 | 0x9deebb5d1b22e4a6e027977cead13893a7e4cc1a | 12 | $16.065004 | $1.400000 | 2 (16.67%) | 0 | 4 (33.33%) | 2 |
| 27 | 0x1937e2d648b8f07a03429ae35f28c4942a756c94 | 13 | $0.644500 | $0.049500 | 2 (15.38%) | 0 | 0 (0.00%) | 0 |
| 28 | 0x4aabe17c239ef71c3a26ba7c2b3e0aebbfc1df26 | 54 | $115.500000 | $1.000000 | 10 (18.52%) | 6 | 2 (3.70%) | 2 |
| 29 | 0xd5ba9711a3d052846a3695c70e7fcb8b3168fe7d | 99 | $6.630000 | $0.010000 | 71 (71.72%) | 65 | 1 (1.01%) | 1 |
| 30 | 0x6cab485fc28ec70d3845113b704d4824e4d2b24f | 18 | $18.000000 | $1.000000 | 0 (0.00%) | 0 | 1 (5.56%) | 1 |
| 31 | 0x348df429bd49a7506128c74ce1124a81b4b7dc9d | 99 | $0.990000 | $0.010000 | 0 (0.00%) | 0 | 12 (12.12%) | 8 |
| 32 | 0x8bc2aecdd86097f74a1a5fa17764108d9a683c8c | 100 | $1.010000 | $0.010000 | 1 (1.00%) | 0 | 4 (4.00%) | 4 |
| 33 | 0x617da9383fba67e86137bc4924b8b7e400fb7c9e | 59 | $458.579437 | $0.020000 | 13 (22.03%) | 11 | 18 (30.51%) | 7 |
| 34 | 0x9fb365e4e9385e2a39febad70368267e6f571d9a | 100 | $0.971000 | $0.005000 | 17 (17.00%) | 11 | 2 (2.00%) | 2 |
| 35 | 0xbd62f8dcb52e21ca5bdf20ba173488da101ebcf0 | 24 | $6.610000 | $0.050000 | 9 (37.50%) | 8 | 7 (29.17%) | 4 |
| 36 | 0x8e57bfde053dbb6862991759c19affc5f383d5d0 | 65 | $0.529000 | $0.002000 | 16 (24.62%) | 16 | 25 (38.46%) | 7 |
| 37 | 0xf732ea490c5766071785a2310523f7fa2cebb829 | 100 | $0.500000 | $0.005000 | 0 (0.00%) | 0 | 0 (0.00%) | 0 |
| 38 | 0x2e8dfc2a77adcdd865a46293844c250462a1c32d | 10 | $0.249000 | $0.010000 | 2 (20.00%) | 2 | 0 (0.00%) | 0 |
| 39 | 0x158e90dd58fbe897ed8c244f472febee37283d00 | 100 | $1.099000 | $0.010000 | 8 (8.00%) | 8 | 1 (1.00%) | 1 |
| 40 | 0x338d8649efa45b940d6656030faa58d9d01e6983 | 17 | $0.162000 | $0.001000 | 5 (29.41%) | 5 | 0 (0.00%) | 0 |
| 41 | 0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0 | 100 | $1.044155 | $0.002000 | 51 (51.00%) | 41 | 7 (7.00%) | 5 |
| 42 | 0x7f985b1764f79faa42a4622bb605b23c8eb5abea | 30 | $4.260000 | $0.010000 | 4 (13.33%) | 4 | 8 (26.67%) | 8 |
| 43 | 0x66d7c2f952362bfb24fd7f02a9bec9c754ea83bc | 100 | $6.264000 | $0.054000 | 17 (17.00%) | 10 | 17 (17.00%) | 11 |
| 44 | 0xdd350976b8cffc65938c0464d39a2c78be079bd0 | 100 | $229.867000 | $0.001000 | 64 (64.00%) | 64 | 12 (12.00%) | 9 |
| 45 | 0x788b4ca11950879550353d8ae82d1c0af6018454 | 100 | $40.970000 | $0.010000 | 15 (15.00%) | 14 | 29 (29.00%) | 15 |
| 46 | 0x50ab2018c06c6e4eaa9ba52057eb55ed284912fc | 100 | $16.035000 | $0.100000 | 27 (27.00%) | 8 | 49 (49.00%) | 10 |
| 47 | 0x3f60008dfd0efc03f476d9b489d6c5b13b3ebf2c | 100 | $24.550000 | $0.010000 | 55 (55.00%) | 55 | 2 (2.00%) | 2 |
| 48 | 0x96368628b679a459fe69815bacca5cb0232ac397 | 100 | $0.937000 | $0.010000 | 0 (0.00%) | 0 | 3 (3.00%) | 3 |
| 49 | 0x5b32c973596078a967562ca652761404f19be0e9 | 98 | $33.694000 | $0.002000 | 74 (75.51%) | 72 | 25 (25.51%) | 14 |
| 50 | 0x6c0752c09e7f6fa6526fcdf40e456a159ebb5621 | 100 | $2.940000 | $0.005000 | 62 (62.00%) | 43 | 1 (1.00%) | 1 |
| 51 | 0xb92bb76e3c5575160a2a561913047727d33af9a6 | 45 | $1.358000 | $0.005000 | 13 (28.89%) | 4 | 4 (8.89%) | 4 |
| 52 | 0xd494a454888a390b2b05df74ae2b5fd9c9902b71 | 100 | $1.788000 | $0.001000 | 35 (35.00%) | 35 | 5 (5.00%) | 4 |
| 53 | 0xcfa26f13c6c18307033ece13bbb8f470da5b4dbe | 100 | $6.000000 | $0.060000 | 0 (0.00%) | 0 | 19 (19.00%) | 14 |
| 54 | 0x837c40e2b4e976f43ffb4451ee281a00fa9477dd | 100 | $21.750000 | $0.150000 | 6 (6.00%) | 5 | 5 (5.00%) | 4 |
| 55 | 0x4842a7d5b2553f4385d5e8d0cf1b94a10b99dba7 | 97 | $0.381000 | $0.003000 | 22 (22.68%) | 19 | 76 (78.35%) | 8 |
| 56 | 0x942bd3e3073543c674efc0c378d5bce20f9120c1 | 100 | $38.600000 | $0.200000 | 7 (7.00%) | 6 | 49 (49.00%) | 9 |
| 57 | 0x8836b033566cc871b069c90c38bbde5c03182c33 | 41 | $66.610000 | $2.000000 | 5 (12.20%) | 4 | 14 (34.15%) | 6 |
| 58 | 0x6d6e695b09861467c7d462f5aaf31cf3540b9192 | 100 | $0.756000 | $0.007000 | 2 (2.00%) | 1 | 10 (10.00%) | 10 |
| 59 | 0x812db9b2691a457b67eb72f6b76a7fb4413d33f7 | 5 | $5.500000 | $0.500000 | 2 (40.00%) | 2 | 0 (0.00%) | 0 |

## Caveats

- Delivery is invisible on-chain: these numbers say nothing about whether the buyer received what they paid for.
- These are floors, not failure rates: only patterns visible in transfers are counted, and every proxy can miss real failures.
- A payment above the mode may be a legitimately different product or a dynamic price, not an overcharge.
- A repeated identical transfer within 120 s may be a legitimate second purchase, not a duplicate charge.
- Dust and unrelated transfers are excluded by the dust floor and (where verified) by the AuthorizationUsed join; in the all non-dust view, unrelated transfers above the floor remain.

