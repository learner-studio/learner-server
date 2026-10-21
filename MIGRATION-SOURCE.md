# Migration source snapshot

- Source repo: /root/biztools-dev (working tree, NOT HEAD: HEAD cannot build — untracked Learning modules are imported by committed code)
- HEAD at snapshot: `3cc7d980fd4c5e5ce97a55bd1dd5869e0445cc03`
- Snapshot taken: 2026-10-21T22:01:15Z
- Frozen copy used for the port: `/var/tmp/learner-source-snapshot` (rsync of the paths below)
- Git status column: `??` untracked, ` M` modified, blank = clean tracked

| sha256 | status | path |
|---|---|---|
| 4d078728d46f79f5806ed2ef426801dcb4c6eb1de26c2f1eccfd1d1c8b1b2857 |    | db/postgres/0143-learning-hook-events.sql |
| e632b79861430f02c50bca3430096920981cc6f3a1e94c06d6ebef2203f9d9fd |    | db/postgres/0144-learning-hook-model.sql |
| 6fea1e6489c3db9d4bcccc49e9722ab487131a296a4a8fcaf9d5aaaa9f6857f6 |    | db/postgres/0145-learning-curriculum.sql |
| a8ea1aacf8450fbc0bc7cbe10dc9e37aefa4deddf1975577b4f907a66d988866 |    | db/postgres/0146-learning-extraction-benchmarks.sql |
| 4ed1967669e3c6d7f056404158608d8aeabc0b80af1810c3ba9e523f6bc91b8e |    | db/postgres/0147-learning-extractor-config.sql |
| ba98244d6450f46191a9718f032f00279c777f1f57c7455ea97f58c0e36190fb |    | db/postgres/0148-invalidate-learning-benchmark-v1.sql |
| 816702332b1b2cde9ced9f773c58dff3e9952d757e79f1fb6a97ce0924ee9651 |    | db/postgres/0150-learning-extraction-human-reviews.sql |
| b89da26f24f0d33551909e09be9bef90fbd9f70e4e2dfccd61a48ab037af843c |    | db/postgres/0151-learning-turn-context-shadow.sql |
| d82462bc5b613532c6affb49678c05b0e3aa46619f7df554aaeac9a75ede0574 |    | db/postgres/0152-learning-episode-outcome-steering.sql |
| 0e488815201c6a08a93f29bb595aaac12dd22e916b35aafcfc68c07fbec0603f |    | db/postgres/0153-learning-transcript-archive-checkpoints.sql |
| 5c2d0d0955bd42bc3a0f9edbf34785e06ad666d8af80e70143c7e72096e183e5 |    | db/postgres/0154-lossless-cli-archive.sql |
| ee6bebec902c609e4b6e715e57a2bfc0ba5da00bf5e58e2957fa188b070ddc3f |    | db/postgres/0155-learning-exposure.sql |
| cb2613959fe04ef38c56479bc43fcd66f10b586b73a525b9c2f5f5fd965d2f56 |    | db/postgres/0156-learning-experiment-output-tokens.sql |
| def59d0970b395ec0542e6720a9dbc17a6f3f0e7208d79b38b8803824c74b95b |    | db/postgres/0157-learning-extractor-default-agy-flash.sql |
| 9d00116498edb4532828b2ba1c6f28e2c7ba809f4cc5400b6e4c19eecb9de231 |    | db/postgres/0158-learning-exposure-work.sql |
| fcaf8de70317a16fdc9d4a879a0fe41b430ea72d00433d6212666e0a1e88aad2 |    | db/postgres/0159-learning-hindsight-agy-bridge.sql |
| 8b7ce6182e3fe4d3d6ffee685e38658f2a03a8a795792403d73f83c9d07c505d |    | db/postgres/0160-learning-hindsight-consolidation-trigger.sql |
| be5e0b2188c31e1e767917203ccc219f5510110a63b10ec65d86a91201adab0f |    | db/postgres/0161-learning-semantic-index.sql |
| 1d55173a63a810a70891ea20279395ec06d0347c4bdfc46b6337add159a683a5 |    | db/postgres/0162-learning-concept-assessment.sql |
| c75ed9c0abd4d666386928ce0a383ff67a8b1e2a2a515a9a37e8c472d6fd5873 |    | db/postgres/0163-learning-vector-turns.sql |
| b745fdbc344a5b961c67ded19b9a737407fef645298a2e2de78a0113eeb1d2ca |    | db/postgres/0164-learning-live-feedback.sql |
| 751d1ce320b628869a6516abdca94148128f473ba43cd25653ce675d7b9983bd |    | db/postgres/0165-learning-feedback-traces.sql |
| 1d6156945f840e291690070ce0fd1f097ac93535da7f445605ff5156240a9258 |    | db/postgres/0166-learning-active-archive-coalescing.sql |
| 2d8f4adb8c05189a2af51e18066b0686a36b89c3a7413f21d08b9782f5ddcb2b |    | db/postgres/0167-learning-index-admission.sql |
| 58c72851e4e9be78e0886c5d7350597013399f5ef4369a4e253c408ada4c5f0b |    | db/postgres/0169-learning-cli-vector-e2e.sql |
| 098117b8a9fef7cd65bebbb2cd96b3176b93e849e6b202ae185fdeacfac6ec04 |    | db/postgres/0170-learning-cli-vector-e2e-cleanup-state.sql |
| 60ba372acd008d60b1416834f27d4b49c1bb480c1e603a6b9b72114801a57215 |    | db/postgres/0171-learning-reactive-consolidation.sql |
| 290a60affb9d83faf056832bca2e4b02c21805227261290c76293b946bac6290 |    | db/postgres/0172-learning-reactive-arrival-identity.sql |
| 6a9011af207d1d0ac8dcef3841bbad28bc253257ce36538210f0a96d1de53a54 |    | db/postgres/0173-learning-reactive-nine-slots.sql |
| da93d77b81bf0bfb4e0f00973c2e03339c9c50e5fc7cbce5807ca21f46c3e513 |    | db/postgres/0174-learning-consolidator-prompt-ab.sql |
| 6bcb3b8f7288188dbbca9173a9a700e4763db9cc3b6048d5881423caf8becc7b | ?? | db/postgres/0177-learning-generated-curricula.sql |
| cd9f1299ce22408707605a1f287c86606a14458111c06df85becd8460ae702b1 | ?? | db/postgres/0178-learning-curriculum-run-events.sql |
| 059a2827db37f25c890b52939dd8cf970b5b483f463657717c0d59d4d4f47621 | ?? | db/postgres/0179-learning-concept-tag-experiments.sql |
| a41d0a3596bf3035b5e460231ddfd106b76727da77d8be9f8d4d4deec7654de0 | ?? | db/postgres/0180-learning-concept-tag-enqueue-time.sql |
| 80b89562daa529d565528f33dc4d077e2998a4cd4d237165e6441383c316ca02 | ?? | db/postgres/0181-telemetry-outbox.sql |
| 1c9061f82436a7d894a1d73e81c4ab26f57d65099c2f9507c5fcece77a241e26 | ?? | db/postgres/0182-learning-concept-tag-reservations.sql |
| 354ba5ee12f984770564ca9d4b4ad763d863673b892e0ce2515f7a4ed46bbd35 | ?? | db/postgres/0183-telemetry-queued-export-states.sql |
| 1431791a7dad2c04d489064f58dc6c740bd946cd97bf818e6575a4c2c360c7a5 |    | db/postgres/0185-learning-hook-health-events.sql |
| 30576875ed9ee156eaf2ef4affaf3c5c2b7734a118a07efc3f0287310f764f70 | ?? | frontend/src/pages/Learner/Glass.tsx |
| 08c5a5e8fbe2c21f1cf7698e9d1451be7c46d20743308366832cc8c09e804059 | ?? | frontend/src/pages/Learner/Learner.module.css |
| 712e5c5fe09ec606492846e4fa8f327bf44690f286d122db5f8f3ee99d5a4ac0 | ?? | frontend/src/pages/Learner/LearnerHeader.stories.tsx |
| baea9440626ba7ae1b67547e5e59a393e04eadc5c4403464af934fa10ea59c3c | ?? | frontend/src/pages/Learner/LearnerHeader.tsx |
| fea9546e317e9bc5252965351da697ccd29492670a25087c2c6f2fd8f1e28381 | ?? | frontend/src/pages/Learner/LearnerShell.tsx |
| d4811d26d02cde15f5dd3b3898fac3535b2f1692f3576331c4b07c6c4a08d979 | ?? | frontend/src/pages/Learner/LearnerTheme.css |
| 8e9cea07d4d52be488a9a1a17f7f214f998d1ef6547a00d395e65c360c5cd5a6 | ?? | frontend/src/pages/Learner/LearnerTheme.tsx |
| e78b94ee7e470ce771c03cc8b42f3d5ac6f371cc2c110008157631e9ff0dda29 | ?? | frontend/src/pages/Learner/LegacyLearningRedirect.tsx |
| 65b909b78054ac95bf8615fa8ca55a3896b4f2450d0c1d3cfe5a305954282bc0 | ?? | frontend/src/pages/Learner/LiveFeedback.tsx |
| e3a01416bdea6c95761927591d08d9dbbf711f4f30da001fcff75dc123792f39 | ?? | frontend/src/pages/Learner/Progress.tsx |
| 5b4210167b26676b98a7c5e36f3f8dee787631045fd0bf8a8004bd2547efaea6 | ?? | frontend/src/pages/Learner/index.stories.tsx |
| 576f241179873b7470f96456fde2a3e4249cbaa1171568fa133eeb56d94adca9 | ?? | frontend/src/pages/Learner/index.tsx |
| 26ce53ff7260837544b2109d6efc842b8e678d185a2ba99182ab8a02cf428a2c | ?? | frontend/src/pages/Learner/routes.ts |
| affb3d0cdbe9ea0e76838b842980e07d1149c8bca1d36927fc896d037438c0d5 |    | frontend/src/pages/Learning/ConceptAssessment.stories.tsx |
| 885f13f1bea2f72d62a1b7c69f250a9f2cc8e9e071bb7fce989a3bdcc67fa395 |  M | frontend/src/pages/Learning/ConceptAssessment.tsx |
| 94a03d4e59ebb8e389b7c3296e39816adef5089e372f6fb0948e82d239756dae |    | frontend/src/pages/Learning/ConversationDetail.tsx |
| 8a9faf45772277e4f9619fbdafa914cc401bc5d8202417f221e465bddbb99c1e |    | frontend/src/pages/Learning/ConversationFolderTree.tsx |
| c883d954f5185c45f84360208e995a92c3be807d4d7b90acd17701da92cd1646 |    | frontend/src/pages/Learning/ConversationHistory.module.css |
| 6ec17ded8a8a9a476371ce87c771523deb68fc10af4d3addf6f916bfe708e1cc |    | frontend/src/pages/Learning/ConversationHistory.stories.tsx |
| 79e04c675195673cae1555169d74d193de8500b451880bc64df3c14185adb628 |  M | frontend/src/pages/Learning/ConversationHistory.tsx |
| 5e87775639e6aec7c2f53d31348e83bb5ee1f2ab478878aa614c1766bf441d5f |    | frontend/src/pages/Learning/ConversationThreadList.tsx |
| 646447faaa1398c424c4e495feadbce0394cf5e2656b2e67d3a92b0cb3883db0 | ?? | frontend/src/pages/Learning/CurriculumBuilder.stories.tsx |
| 81c7063536455cb7db224c897da5a6aba9c6b163b781bc469e282d13bf4bf5b4 | ?? | frontend/src/pages/Learning/CurriculumBuilder.tsx |
| 390de766b51348f514695c2bec565027fe552bb2fd33b627218a22409fafaf00 |  M | frontend/src/pages/Learning/CurriculumTree.stories.tsx |
| 904b5900d60a6f988ecfca541b7a1dd32c9a7d9f6001615193a924c4cdd027fc |  M | frontend/src/pages/Learning/Learning.module.css |
| 8c6a050dfc9704b6e6516eb9b540894c946d2b62f2d1acc15990cfa1c2f02a55 |    | frontend/src/pages/Learning/LearningHookHealth.stories.tsx |
| 271b51ce837ca48dda661e772cd9c8d0cc525be2ebba834d0f33553a77a53557 |    | frontend/src/pages/Learning/LearningHookHealth.tsx |
| 47f2a53871039afef33c5caec76c737c3a4026c67c4ceb72fcebe2fddf807b77 |    | frontend/src/pages/Learning/Playground.stories.tsx |
| f959735b0112588af723ceacae3e3e0d5194390b41ba03234ea469b4e1be51a6 |    | frontend/src/pages/Learning/Playground.tsx |
| 4eca7c4ec703ccca2f583aefb6eaf68276d9da93f93a86ecf246ee614609c02a | ?? | frontend/src/pages/Learning/PolicyModal.stories.tsx |
| c8ec50d3ba658e9e7798e6124acf150f394fade277ffd968961508b23c1465a9 |    | frontend/src/pages/Learning/SemanticIndexStatus.tsx |
| 887e0368ac656422304f1425365a6d60619b3738fb0947d3ac45bf2092c71e1e |  M | frontend/src/pages/Learning/SigmaLearningPage.tsx |
| 303aa1bf6f97250aa2598d9ca101dee2d6de603c781f45cfb7b6d0938940a62f |    | frontend/src/pages/Learning/VectorExperiment.tsx |
| dba67916b615153178f712d11be89c405fbe2fa6c7b94ea6887ecd8afce4f6db |    | frontend/src/pages/Learning/conversation-history-model.test.ts |
| ca8b6cd2a716c867649341b9aec34822480470114fe81d0272769d5e0ca3ebe4 |    | frontend/src/pages/Learning/conversation-history-model.ts |
| 1a2a55840f7318a67eedca07593eba8d1ef8b99dbb85c8d2ab26afc2c6d2a002 |    | frontend/src/pages/Learning/curriculum-rollups.test.ts |
| d291bfe40fc89f008fb104c59f8ffa43c412fbb5162f66004a952fcb1d64a7b0 |    | frontend/src/pages/Learning/curriculum-rollups.ts |
| e2346e63f2b3170f8b3e49dcf26aaded9407dd52cac2fc5b49ad40638f1fa30c |  M | frontend/src/pages/Learning/index.stories.tsx |
| d522728bf2a91cd0c7564918750da62b10b7264f7125b1e4cf9e9941701962f5 |  M | frontend/src/pages/Learning/index.tsx |
| e00b626df0aee5161a6d524cf2f680307326b1b8c409792a3dd0b3527df15544 |  M | frontend/src/pages/Learning/skill-tree-layout.test.ts |
| c579d1e1bef50a49c2e1d5255459dcbaa55f1302eeb58ee9c5ef46538bbbfe33 |  M | frontend/src/pages/Learning/skill-tree-layout.ts |
| ae757d335d984cc50324f11f8b929b7ddc0365d8be8dc61103115ffdc9e7e97e |  M | packages/functions/src/db.ts |
| 482dc77878f87742df3e53fa953ee1406f902495d39c712067fb43c4b9b0cd57 |    | packages/functions/src/functions/learning/computer-science-2026-09-04.snapshot.ts |
| a8decece8efc9dd1342395bfb2a619a705a4d36149679c0958903643cc9eef31 |    | packages/functions/src/functions/learning/computer-science-prerequisites.ts |
| 010c769c5330c0957dc5b7ff407954492d6a064a5bb738ba5a07734e4631b405 |    | packages/functions/src/functions/learning/computer-science-seed.test.ts |
| 9b6e55ec1114aee811a43fadbc59ea0c982e965289d479cdece65d99d1cc31a3 |    | packages/functions/src/functions/learning/computer-science-seed.ts |
| ca7350b7b1a7a82d496fb6fe1b81dadb214e4897e919b84966eabb8ef05886ef | ?? | packages/functions/src/functions/learning/curriculum-generation-rpc.function.ts |
| 526b1996c655ed2068a5c2383761bdb526293ad57c5e49640a0589a5f00b849a | ?? | packages/functions/src/functions/learning/curriculum-generation.function.ts |
| 56b35b46126bed3860e41b289ca777b2a3a67a91cf96036e22f5d2adf522b3da | ?? | packages/functions/src/functions/learning/curriculum-shape.function.ts |
| 30eba20cf3111cd6fdfeaf3aed7f1def6148ee9239b8a05cedb334f1e0e812df |    | packages/functions/src/functions/learning/get-conversation-history.function.ts |
| da9115e4862765560494e82a8c5a536e5656e0893f23968bc73f9dd3c49f0b33 |  M | packages/functions/src/functions/learning/get-learning-graph.function.ts |
| 5e13978a83e7019d3fd23664d9faff7d32498cf57fb5eae7d57f2d3183e1acd8 |    | packages/functions/src/functions/learning/get-learning-hook-context.function.ts |
| 9ad1e51bd61d7caf90db512bce5cd6d532bc7ebf3cd45823d191e6be8a08b745 |    | packages/functions/src/functions/learning/get-learning-turn-context.function.ts |
| d07be429b0d76acccdb1070f5dfcbd9d73a30425ef302f724b9557412ad4ce08 |    | packages/functions/src/functions/learning/hindsight-agy-openai-bridge.function.ts |
| d089928e56786ab06129f4219045c310f26de123814f3c0e5114d73610b787a0 |    | packages/functions/src/functions/learning/hindsight-realtime-consolidation.function.ts |
| c7e10d7386700021c52e8827ef3737876d30e27636c4b568dfd4502419c57e38 |  M | packages/functions/src/functions/learning/learning-active-archive.function.ts |
| 24461be79a274a5dc60a8d495e2b1f574fb4c30adc6c3200e597a7b3611779ed |  M | packages/functions/src/functions/learning/learning-archive-coordinator.function.ts |
| 7330ff361a5fe7c6ab358b4475046bb7301113deeeb5cdf79783248aff2a32db |    | packages/functions/src/functions/learning/learning-cli-vector-e2e.function.ts |
| a40cdbdd6610d6098f698714088fbbe1e3fc02b5336868e7b41d1035fe88358f |  M | packages/functions/src/functions/learning/learning-concept-assessment.function.ts |
| 74622561e2fc20ee9cca488ed982f69878bb7e9ba293bd089e5559e2023cfbc9 |    | packages/functions/src/functions/learning/learning-concept-coverage.function.ts |
| a3d4d91e252b9bd945d66917bd7c4f71a1932f6a567288a3d4f1de5546bcf6ea | ?? | packages/functions/src/functions/learning/learning-concept-tag-audit.function.ts |
| 4e74565d17900e18485f7e033b6c79c6902ec00009191b3d33e5594557057aa4 | ?? | packages/functions/src/functions/learning/learning-concept-tag-historical.function.ts |
| 83adba270d6999f4adf1edbc36cedc501e3fed6aae4c5d215766d8bc936002f2 | ?? | packages/functions/src/functions/learning/learning-concept-tag-readonly.function.ts |
| 9fcf094f05b70b9819cb0eacd9ac7f0b2ccf2b77fa51be3f5df50059718be148 | ?? | packages/functions/src/functions/learning/learning-concept-tag-rpc.function.ts |
| 0f933a110f1fb4c0ee43f5bdf1f1e1c95a99eeda4982a126ae0ebce8c873ecb4 |  M | packages/functions/src/functions/learning/learning-curriculum-store.test.ts |
| 0fcdbb8952bc8296e6a5c07dfb3d98bb84ab972bf0736ae62879258d7620534a |  M | packages/functions/src/functions/learning/learning-exposure.function.ts |
| ba517032f63290c3b4740ad346def4fe53e9995e50493e9033fa09bab0aa8dd2 |    | packages/functions/src/functions/learning/learning-extraction-benchmark.function.ts |
| 04150de09d1db3c65805bf58daabf9193feeb541a387e68d1e96be947e3317aa |    | packages/functions/src/functions/learning/learning-extractor-config.function.ts |
| 0a9db2c037593feb7707dce748aac8b2925b61b72a0f4b174dacd43235406be8 |    | packages/functions/src/functions/learning/learning-feedback-traces.function.ts |
| 7cf533b1d7ccac188e231f6423cd1216720a76713d8f8b6ac2b6bf2c85906d12 |    | packages/functions/src/functions/learning/learning-gradual-assessment.function.ts |
| faf288664b0780e7d093649b0f4c0ddb37277555e4b9f6a8067c3b4322dae580 |    | packages/functions/src/functions/learning/learning-graph-output.test.ts |
| 79d07fb0ea8ea3096e9286eaa9d4d57eeef3c40c80f95b65ef64fc9a438c30bd |    | packages/functions/src/functions/learning/learning-graph-output.ts |
| 7d48d24606e719c609e2ca14e8d86f0661c41c471d0bfb834d2e6b0aeea29ed9 |    | packages/functions/src/functions/learning/learning-hindsight-native-pilot.function.ts |
| fc5d38ee8b249c4687254f2aa1d53f33dca31cad3f17355ffd76d9b596d0a216 |    | packages/functions/src/functions/learning/learning-hook-health.function.ts |
| 4114190b3c5c7ecfbeb1ffb9c30f64c4363794df2c77a0958394d716906ddb45 |    | packages/functions/src/functions/learning/learning-incremental-grading-experiment.function.ts |
| 522f3f0cb3ad0003ad2a64cfd22b35667f9c0aeab6874dea56f56bfc0773622a |  M | packages/functions/src/functions/learning/learning-index-admission.function.ts |
| 194a90a68906f37319530f3777a2501af6f0055ac251ad03b29ade2fb345cf6e |    | packages/functions/src/functions/learning/learning-live-feedback.function.ts |
| 39224469b44941ea762f779aea8aaecb13637593804de9db8102d1fcf8583eb1 |    | packages/functions/src/functions/learning/learning-lossless-archive-proof.function.ts |
| e662779230aacabea50d96e0c30b23bcca763d68fe75437a2fe9c18f1b773385 | ?? | packages/functions/src/functions/learning/learning-mastery-model-comparison.function.ts |
| 944b3609849f944271a972390e6221f1a27488013932cd13345ed934971a2f2b |    | packages/functions/src/functions/learning/learning-playground.function.ts |
| 93273e8adf60bbc69afb7170e2e5477095e920db44f06546c05f8c48b221b079 | ?? | packages/functions/src/functions/learning/learning-prompt-ab-audit.function.ts |
| 933461620c443275a084d7c16c837623f122821eb9b69f4fde5ba69d7f3a61db |    | packages/functions/src/functions/learning/learning-prompt-ab.function.ts |
| 9a48872874d29b72201ee025075b074d0d1c3bf224f74614d40c5cfdb02cf758 |  M | packages/functions/src/functions/learning/learning-reactive-consolidation.function.ts |
| 0779119b6ce51fbd707601ebb8021b0de9a22d0ba2d2e7287050244c6c1eee66 |    | packages/functions/src/functions/learning/learning-seed-v1.function.ts |
| b27676ca4f60d29039a48dcbeb3c3cb18688f799831d328ada08f4a02b23930b |    | packages/functions/src/functions/learning/learning-seed.test.ts |
| 71d33043e76fd4fbfeedb4c89f2008bf0a36b48377f65064e5c9026a61ef21bd |  M | packages/functions/src/functions/learning/learning-seed.ts |
| 368c2bbce27884d8063be388f9c668dbc070bafbddf29def3eb9a03789e4054d |  M | packages/functions/src/functions/learning/learning-semantic-index.function.ts |
| 76c45ed4253a2775f2e0b641eb43aa0d31872d7acbc7d9b95a2fabbce8d1f39a |    | packages/functions/src/functions/learning/learning-vector-rolling.function.ts |
| 3d9504a1daddd8adbcc5be9df13026de78050a501b50d983b26ab2cbfbb1dcc2 |    | packages/functions/src/functions/learning/learning-vector-turn.function.ts |
| d1ad44dd082f94b383259e5d8e768519b347e193322781c0d22bfc6e74433e59 | ?? | packages/functions/src/functions/learning/learning-worker-runtime.function.ts |
| 7328250edaa20e3b9ee68128de94fb4bb94157bcc1a668921bc53b1cc7e2cf87 |  M | packages/functions/src/functions/learning/lossless-archive.function.ts |
| 79e7481027241a96c3f91fc24ef2240669b3b4078806064788675fbb6cebcf7c |    | packages/functions/src/functions/learning/outcome-steering.function.ts |
| eed8d2f3fe8bef09e313621a2e7f2b0d796c738b3db8b753bc145047fc4ff802 |    | packages/functions/src/functions/learning/practical-computing-seed.ts |
| 30cea0f0f2ff03e87b8d665ea3d9bfe880fbdc2cee1f67c52f9300cee04a065f |    | packages/functions/src/functions/learning/receive-learning-hook.function.ts |
| 84d6374669e8c821796b352ef533578375d157b0e236d76cd5bffe04316843ab |    | packages/functions/src/functions/learning/transcript-archive.function.ts |
| af794d71c8bce60e94ef257e1f57b6b528ba2552c7f2ce3cb26eb681517aaa83 |  M | packages/functions/src/functions/queues/learning/learning-exposure-drain.queue.ts |
| 87bf31eb89f2af5504bf6dc695735f3aa93a168b5ddb1bf95ba57a21dfc8f5e3 |    | packages/functions/src/functions/queues/learning/learning-hook-ingest.queue.ts |
| ec30174b296dac042e7c1e93c5f2da1736b8b132313ef7a66f1c43007adf7461 | ?? | packages/functions/src/functions/queues/learning/learning-maintenance.queue.ts |
| bab7ed92a84839769c7ab44eafba3f6b5e68f114c6e740120d3bfedd7169aa8c |    | packages/functions/src/functions/scenarios/_learning-vector-turn-proof.ts |
| 6476fe7ead110a5d71be6accd1f66a5b3bc4ed66bb1d80169ebdd3fc17b89d05 | ?? | packages/functions/src/functions/scenarios/_learning-worker-lifecycle.ts |
| a42c9cb2bb2aea1182a1b734b1e88a31e106aadebfc06e5b22cb9b236061edcb |    | packages/functions/src/functions/scenarios/learning-archive-coalescing.scenario.ts |
| a6327d56f07ad43380786eed92dfa72eae2acd01b70c593da97a13347090ded1 |    | packages/functions/src/functions/scenarios/learning-classifier-native-schema.scenario.ts |
| 97e4856add9001442b08300ccfd13c64153fbdb6610bca93f6a36e7586e1679c |    | packages/functions/src/functions/scenarios/learning-cli-vector-e2e.scenario.ts |
| aa48973d1ff2c0ac3882357f2a7dda69daf10b6d8d77a3e3459f412dcf85f915 |    | packages/functions/src/functions/scenarios/learning-concept-assessment.scenario.ts |
| b1a36ddd350222e5aebf380cad9d243291719753de40d9985e580daa14566a2b | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-capped.scenario.ts |
| 3095638c8290bc431976b71dbd372fbb61c259e8d8865f881f2589ed87e94fd5 | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-experiment.scenario.ts |
| 37d4da21449665ebdb345c0a6f5a0b2379d9be974b0d6f62dfb6fbea108347a6 | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-followup-performance.scenario.ts |
| 42a8e4064665c07312b0e49dbb3bbfed1d5dd39e30cbad6383e9afa0dc728c9a | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-historical.scenario.ts |
| 78e48e9e17fed84d4a6cd6c92a456c15b3071ab065f4a93d5ba9f1c33303e38c | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-live.scenario.ts |
| 049a4bf65ee8a4da38b2908f38ddb619fa0abb82174a47d4bdfda62a55499229 | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-performance.scenario.ts |
| eacbe955261c75bd361075db421cced1b308ae5bc6aa1ec7711e0f2057bc13e7 | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-readiness.scenario.ts |
| b8bdf976bcfe6e48cd63f867caa62c76d199b8b72042553cf1d1972478e64761 | ?? | packages/functions/src/functions/scenarios/learning-concept-tag-selection.scenario.ts |
| 74ee123d8c032281a2c3e26be29d1c2ee609948e1dd415b2a9634f7e7ff16084 | ?? | packages/functions/src/functions/scenarios/learning-curriculum-generation-probe.scenario.ts |
| 852bf2f8f0cbc0fea15660d167f21450f065446c02a19b828a81f2852d5381b6 | ?? | packages/functions/src/functions/scenarios/learning-curriculum-generation.scenario.ts |
| 82469da0293ebbc256afef43f3b1acfca82c1faf8a411b3e95e90537fe04dff0 |    | packages/functions/src/functions/scenarios/learning-curriculum.scenario.ts |
| 933f83532bef5ce8f0b3da2719c1f6d1af100118096d1d3b822f8244fb1a9304 |    | packages/functions/src/functions/scenarios/learning-exposure-parity.scenario.ts |
| 9e281a334f7b97f572f266c46a769132d5130456ef19ccfe4abc731504a554d0 |    | packages/functions/src/functions/scenarios/learning-exposure.scenario.ts |
| fc6942d6b854039c918e8a7bac9f523d15571c220614bd56881b06a7733fdf35 |  M | packages/functions/src/functions/scenarios/learning-feedback-traces.scenario.ts |
| 51778f80fada12d799627effaa536e43cc207ad4be8108c3158cb91f3c6d4ba8 |    | packages/functions/src/functions/scenarios/learning-gradual-assessment.scenario.ts |
| dd01752f428a7300317e097af343e053f9e9ec9e78e87b0841629f27468707d3 |    | packages/functions/src/functions/scenarios/learning-hindsight-native-pilot.scenario.ts |
| ce9f68b1f8f210086eaf615736a564f723dbc64be829b9560d284f161f632432 |    | packages/functions/src/functions/scenarios/learning-hindsight-realtime-consolidation.scenario.ts |
| 06fdf8c4582178518721c4f0cb63ffa04bbc0af135d5d36709a1c5a38eac2b4c |    | packages/functions/src/functions/scenarios/learning-hook-context.scenario.ts |
| c733a1cba8c6f128a21a6ea27591325128e5d2ce7abede94ec0af185b3c14111 |    | packages/functions/src/functions/scenarios/learning-hook-delivery.scenario.ts |
| 2f9b13e13fbc70eff8ca4abe42055a460a81f2661cd5d8ec012c79a2bbdbd3e2 |    | packages/functions/src/functions/scenarios/learning-hook-health.scenario.ts |
| bd94661f992ac811443354e28b070a7a8ad4eb7f5e67da63237029a9c9d46e6f |    | packages/functions/src/functions/scenarios/learning-incremental-grading-experiment.scenario.ts |
| 2892128ecdf741acc1ca8213a32777a842533c89a5f1f091b03da8b4766e487c |    | packages/functions/src/functions/scenarios/learning-incremental-grading.scenario.ts |
| 65cb969aeac908c23cb02972fc2943adf8bfa46d0d09f3641c59c193eecef022 |    | packages/functions/src/functions/scenarios/learning-live-feedback.scenario.ts |
| e42dc8f540816a63b1cb065ce4ec005b15d2dede0ddba1ce10d5faa2586ff329 |    | packages/functions/src/functions/scenarios/learning-lossless-archive.scenario.ts |
| 600a9a66026b69d7915da4b0bd43e88bb71317845a2421e19b1a27abf16fc23f | ?? | packages/functions/src/functions/scenarios/learning-mastery-model-comparison.scenario.ts |
| da642291dd44c66d72784e2496949f40b4d996192952434c8574c565f0155a0d |    | packages/functions/src/functions/scenarios/learning-node-evidence.scenario.ts |
| 14ba6b131992a62d471912693c3009b2d95895c2d91db1e0a53e8f996a36c5a6 |    | packages/functions/src/functions/scenarios/learning-outcome-steering.scenario.ts |
| 2553fb5720f6b296f069f01241c18c86cf65e0ed5d7302afebc01318ffb8d0e3 |    | packages/functions/src/functions/scenarios/learning-playground.scenario.ts |
| aaace2730141184bcf870f5a92bc6543fd83ff053f8203e106f18c49c3ac1b7e | ?? | packages/functions/src/functions/scenarios/learning-prompt-ab-audit.scenario.ts |
| 12d4459bf390efea4f1298707e7974ed23d5c7b03b70829d11714de55fd9fb3d |    | packages/functions/src/functions/scenarios/learning-prompt-ab.scenario.ts |
| 84db9823ee4ff71712820dff16d6f1448b0d1e4e24989c08259b37bd1097577f |  M | packages/functions/src/functions/scenarios/learning-reactive-consolidation.scenario.ts |
| d07f0c5d787ddba616cad0f8eb8fc71e121a97711f2b4164dede001241812408 |    | packages/functions/src/functions/scenarios/learning-seed-v1.scenario.ts |
| 82c6df569f28e369d317ba19032b7f30d0cb58f62b4badce6b7eea83421d9fe3 |    | packages/functions/src/functions/scenarios/learning-semantic-index.scenario.ts |
| 6acf31d46d160049e514001d57128b7f85b2e5ada9061e8d5fef97b7ad2e0ab7 |    | packages/functions/src/functions/scenarios/learning-three-turn-effort.scenario.ts |
| e09574f04e319ecf25c941144bf869db5e2f4349b39c6971f94afab4d3f91675 |    | packages/functions/src/functions/scenarios/learning-transcript-archive.scenario.ts |
| f2d49704b005ab031b4d62fdb37da9691bc90c447244b3ca93badc9fa53d8faa |    | packages/functions/src/functions/scenarios/learning-vector-turn-evidence.scenario.ts |
| 63b00d38da3481cadcd435c2a2f5035b52371e2a98e19c488745870e4016b06e |    | packages/functions/src/functions/scenarios/learning-vector-turn-proof.test.ts |
| 72635f0fc3ab7e4232e7763272518d872e41ef751be52c82281b51995ec68a16 | ?? | packages/functions/src/functions/scenarios/learning-worker.scenario.ts |
| 0c1d538931839ac67e87ee2230908a2c7064ab14fcfacd0358864774eba125a1 |  M | packages/functions/src/functions/scheduled/learning-exposure.scheduled.ts |
| cea29cf3d4575ce3600cc89aae00d56c2004ccac0c6c2403d971be1c91ef9c7d |  M | packages/functions/src/functions/scheduled/learning-feedback-traces.scheduled.ts |
| d62efd45f1b099ed8a210a49964959946fba440eea277d0a91e9d877d1695c91 |    | packages/functions/src/functions/scheduled/learning-hindsight-realtime-consolidation.scheduled.ts |
| 7b349ee89fecb44fe84c2e7eb0bbf8daf06847181eb55ea8871c5ebd991d2af2 |  M | packages/functions/src/functions/scheduled/learning-lossless-archive.scheduled.ts |
| 2c1604f767a897502e38666d13acfd14bfe61a4023b84618086da0496e4fb1c1 |  M | packages/functions/src/functions/scheduled/learning-semantic-index.scheduled.ts |
| a6ba53dbd6e316358f78565e1281bbc3e7cf9700a6867f657badb2b78065f3dd |    | packages/functions/src/functions/scheduled/learning-transcript-archive.scheduled.ts |
| 8ae801904cd002544156014dada4b0e4b252bdc80d5d0d82e5969914d59f14a6 |    | packages/functions/src/functions/workflows/learning/coalesced-archive.workflow.ts |
| 0aeab16725d538d4364281cf0e027691e23961411680dec4166119df2f155ef8 |    | packages/functions/src/functions/workflows/learning/episode-analysis-steps.function.ts |
| ac146fccb501394a72e01232dd2b6f2cc6fa77eca1541d31157fd40618866b74 |    | packages/functions/src/functions/workflows/learning/episode-analysis-steps.test.ts |
| 5d854f1fe74429273f84ebd54bc4b69df0ea7bf2d1ee9a21717f69d3673ad409 |    | packages/functions/src/functions/workflows/learning/episode-analysis.workflow.ts |
| b74b83274af8620e00f75b2e6311559dbf36fa7d764b6f8ac631b1f71f5a4e3a |    | packages/functions/src/functions/workflows/learning/feedback-traces.workflow.ts |
| 0a0faf547720b9ef6e16c23ad896f1ca53f2f9b9581a45c7c4d53b71012af0b1 |    | packages/functions/src/functions/workflows/learning/hindsight-realtime-consolidation-steps.function.ts |
| dc1426dd8992cb1aaa44414bddd4612dc2fdf217936d031eb52337f0e74c31d3 |    | packages/functions/src/functions/workflows/learning/hindsight-realtime-consolidation.workflow.ts |
| 401e51b0bd46d07ad153798db321abb3548bea402b0f25b4a3429a4a56f67e04 |    | packages/functions/src/functions/workflows/learning/learning-cli-vector-e2e-steps.function.ts |
| 817d8c6a64c567610f6c196610e8239f4aaf37c387f4dce977b4f241850a5f71 |    | packages/functions/src/functions/workflows/learning/learning-cli-vector-e2e.workflow.ts |
| 0808712e413abbda5502e52d0323e3fb41a91bbc8b57279955e8bc0fe0b59070 |    | packages/functions/src/functions/workflows/learning/learning-concept-assessment.workflow.ts |
| d6de57d9f79132fc70d68e6003c8a658d86a9ccbea41f7a41bfba942fd46b5a5 |    | packages/functions/src/functions/workflows/learning/learning-extraction-benchmark-steps.function.ts |
| 86dda965107496a2c6e82c338f6f0201bba680b658fbf9c856bcfdc10c0e159c |    | packages/functions/src/functions/workflows/learning/learning-extraction-benchmark.workflow.ts |
| eadd9bc2ff76154b944299c16d9f2e2ca07fee89d0657a46c855cf2fd680e52e |    | packages/functions/src/functions/workflows/learning/learning-gradual-assessment-comparison-steps.function.ts |
| 7fddb2135ef8a4c5908d7aa15f909b9c3bf872faf7d35573ce7f251a8e121ac3 |    | packages/functions/src/functions/workflows/learning/learning-gradual-assessment-comparison.workflow.ts |
| 69b870e626b0fa51ff9c48de4e5a2c05141275f40d08adf990aacf928f062c22 |    | packages/functions/src/functions/workflows/learning/learning-hindsight-native-pilot-steps.function.ts |
| dbaf9d24e9bedea2508f6ac9e77540d4c1034452cf23b4dc2c8ce0f72920532f |    | packages/functions/src/functions/workflows/learning/learning-hindsight-native-pilot.workflow.test.ts |
| d0ed8add22bf57e10d67aeca5e8b105a81ef444ffacab69c985bcc0f7a0e4035 |    | packages/functions/src/functions/workflows/learning/learning-hindsight-native-pilot.workflow.ts |
| 15a449c1def066e10449efd6a008254d6a5a11c17922f40a8202d118a86ed41b |  M | packages/functions/src/functions/workflows/learning/learning-playground-steps.function.ts |
| e04a90de1ae02a6704f6e6b1ee0e8d1fc5e53768b465a171dae4705bbe4b5fc4 |    | packages/functions/src/functions/workflows/learning/learning-playground.workflow.ts |
| 375c5316483121e4acf5b019fec5783821c1478d8225cca981f9754e115f0f40 |    | packages/functions/src/functions/workflows/learning/learning-seed-v1-experiment.workflow.ts |
| 2c165eb7e0828f6409797f0b943f8bfdb167994e6dd87967d9618f5f8c3023ef |    | packages/functions/src/functions/workflows/learning/learning-seed-v1-hindsight-rerun.workflow.ts |
| 8789e2335449f685c2f3692575cc4e112bdca335b43c1061649d866bc7a01e13 |    | packages/functions/src/functions/workflows/learning/learning-seed-v1-steps.function.ts |
| 480beaf634bea7589d50f998d19c2ec164af5694e866600157bf12a237b8910c |    | packages/functions/src/functions/workflows/learning/learning-three-step-proof.workflow.ts |
| 28be7a262c1a50e73ac0b7b23078c5e888dfd1b1924715cfe67c815eac07f756 |    | packages/functions/src/functions/workflows/learning/learning-three-step-steps.function.ts |
| fa79b178849d667c13e680b98800a53746a3c64aabdcb044ea13d97998fe8107 |    | packages/functions/src/functions/workflows/learning/lossless-archive-proof-steps.function.ts |
| fc1a912ce0c84580b8b042fba260ccbce9e657324e6adc573e9796caab258c5e |    | packages/functions/src/functions/workflows/learning/lossless-archive-proof.workflow.ts |
| e6074a9c596d1270d670adcd4f346ae024edc423349c4b37ef79924826a569a7 |  M | packages/functions/src/functions/workflows/learning/lossless-archive-steps.function.ts |
| 8580ba3697cfa272ddb423469d050b11b85de424d40f8cfae69128f2c1c04789 |    | packages/functions/src/functions/workflows/learning/lossless-archive.workflow.ts |
| 91ff7b8fe4330a9c353b3803a9a06bd42fa4a26b9a4c37e67dd45ae0de598f8a |    | packages/functions/src/functions/workflows/learning/transcript-archive-steps.function.ts |
| a18dbb623fafd7c11fe73a02f6f938d4a45ef9bcbc0fdc29e6d1a0b62aeca0df |    | packages/functions/src/functions/workflows/learning/transcript-archive.workflow.ts |
| 22edb0c5f4a9a13c6fe968619e563b0766e3f662dbc07d2f952420495f0e4545 | ?? | packages/functions/src/functions/workflows/learning/worker-probe.workflow.ts |
| 2d96a65da3944c5df3df1dbb766d75d7bdfcaae7c30e0aba57e846d286e83c54 |    | packages/functions/src/lib/audit-event.ts |
| 5fdcec5c3c3a1d021f56d51619ee8467fab888c92399bdd0710834172c7483ec |  M | packages/functions/src/lib/cli/cli-agents.ts |
| 21f5af5c01d487b236f1df0081c1f2dbc60d012242863393123f55494071cd72 | ?? | packages/functions/src/lib/cli/cli-inference-limits.ts |
| 3e3fbe94d9d1312b1458082957b5f7ee2d5b112c28ccb393352c79333e3069e7 |  M | packages/functions/src/lib/cli/cli-observer-registry.ts |
| 53b6d8ca120f537d0578e6f01323ff680be479ecdb5a4ed8bba73cebfde1fcb1 |  M | packages/functions/src/lib/cli/cli-telemetry-types.ts |
| d6561a54978313b9fd69abe124b908c380d5ac1edfc7509bf32c3a3df46fc55d |  M | packages/functions/src/lib/cli/cli-telemetry.ts |
| e119101ae9641dbfc4454798c47c93ba9bb3dac739d77b217af0cd24cc31d8d9 |  M | packages/functions/src/lib/cli/langfuse-cli-sink.ts |
| 592d5b0c1d20a2e528e3ed5a8059b0785855a8ccab8945d5ec1ae2d8430cc2b1 |  M | packages/functions/src/lib/crawler-v3/crawler-mode.ts |
| 3035ab9add50b3e70a70c6d2f4ad54b7ed32cd86695bd97449c915fb26bdb513 |    | packages/functions/src/lib/db-metadata/_shared.ts |
| 67d08026e12e9f738a0b78d85d800a0d06adbe22cf7198ded1a537d35abdb32b |    | packages/functions/src/lib/error-message.ts |
| b2662de37f3b2c7bd62e1c0f86f15b1d0473dc619fa0ef8914c04d4f4533145a | ?? | packages/functions/src/lib/learning/curriculum-generation-types.ts |
| d1e70098bc123703b1e33e4946a443eac18877d123290d1cec4c375da8b2d9f0 | ?? | packages/functions/src/lib/learning/curriculum-page-reader.test.ts |
| efd97445d584cd647d82b18addb5bd2bd13cc080c85b1073dfe83ba69cc89daf | ?? | packages/functions/src/lib/learning/curriculum-page-reader.ts |
| c1377af3361198331d6ab61b52a53dc0e2c6b5c882033e4c1f2e4f5626f34510 | ?? | packages/functions/src/lib/learning/curriculum-prompts.test.ts |
| 5587a52752f632a0769e6e9351a7f9136a1a765c3926722ba2c9deff92412f19 | ?? | packages/functions/src/lib/learning/curriculum-prompts.ts |
| 8b1a4d0c5a10793546cd5fced48ddbce86db4a7e417ec451571061a383204ae1 | ?? | packages/functions/src/lib/learning/curriculum-relevance.test.ts |
| aa9923f17739a3ac96494f4481eb9feaa2b73fac281ed3b06e5141abdaad48de | ?? | packages/functions/src/lib/learning/curriculum-relevance.ts |
| 46fef1ae72209c399364acec82782f9aec1a06412362d296d279f45fd3d967ce | ?? | packages/functions/src/lib/learning/curriculum-run-gates.test.ts |
| 970d68818875d93d62e7f1e456e318c0617ec65caf659d705896f78ec36560e6 | ?? | packages/functions/src/lib/learning/curriculum-run-gates.ts |
| fb4a4d4327adb3ca92a3e2f9d121548c98c922ac1f018035255cd88557fe1eb3 | ?? | packages/functions/src/lib/learning/curriculum-shape-query.test.ts |
| 286ba9206b2917839afd61cf77dceed1050ffcd22fde1f90c308bf8d01abf3c1 | ?? | packages/functions/src/lib/learning/curriculum-shape-query.ts |
| 01bf7127c821e8b78bd5107cdc1747d22330cd1c3ebc80cc5c9876f0ca35767e | ?? | packages/functions/src/lib/learning/curriculum-shape.test.ts |
| 903463ddf63589f950a6f31115c1cf68722fac35fd29e762e40e2850ecc797d7 | ?? | packages/functions/src/lib/learning/curriculum-shape.ts |
| 84c9f79bead65686459fd2fd53be793cde37d695e506af9839f7fdef37a07b86 | ?? | packages/functions/src/lib/learning/curriculum-sources.test.ts |
| a94830140ecab627ac70698219d561f3182066cf56cddc4e00383ed164c3f87f | ?? | packages/functions/src/lib/learning/curriculum-sources.ts |
| b773f4563ee79bf49bcd2db8c3a3254dd2369dedb77b9438d711d0a59e72ac57 | ?? | packages/functions/src/lib/learning/curriculum-writer.test.ts |
| 6df63eb41fea3fb8e0d92854fc63e1a1e77982d2c7215f12ae44ffccb14f4af9 | ?? | packages/functions/src/lib/learning/curriculum-writer.ts |
| 14e35c6bc8ad96d515087180d65682bd84f92a0613504e0fd416c8d3cbd48892 |    | packages/functions/src/lib/learning/hindsight-agy-openai-bridge-db.test.ts |
| ee31ba52a1863c045f150fb8eec3077163383cb0571db6774eb62ed04498bd49 |    | packages/functions/src/lib/learning/hindsight-agy-openai-bridge.test.ts |
| be54acb08fb9dc828a45b0784f154875f155db94cb6ee35fcccafebfa101677d |    | packages/functions/src/lib/learning/hindsight-agy-openai-bridge.ts |
| 42ed6de764a0d3ed57b9037a7c26827d076171768389cf5a372815c5d09df4ee |    | packages/functions/src/lib/learning/hindsight-realtime-consolidation.test.ts |
| 760b43fbfaa99170d9cd2b010259b93e84cca7bb69d5befba9beeb83267b7327 |    | packages/functions/src/lib/learning/hindsight-realtime-consolidation.ts |
| 8f7ba4f3149f35197c95c69d369206a353472fff0236e67dda69369d4546739e |    | packages/functions/src/lib/learning/learning-active-archive.ts |
| 187785f47e6f496e1bbe197e7805818589401f78bdd913d241a254fc7edbbfc4 |  M | packages/functions/src/lib/learning/learning-archive-coordinator.test.ts |
| f6c87f14aef613b8eb904cb8a13096c3180576a6de11ef5a9238fd7b7d8a4150 |  M | packages/functions/src/lib/learning/learning-archive-coordinator.ts |
| b9e0da356afdd9eb0ea008c3c2c2647f156d43cc40387e5bb91a8110e3eed826 |    | packages/functions/src/lib/learning/learning-assessment-evidence.test.ts |
| 7d1f65e764ca3b2e662c2d2e0e8fc9257914c0bb8fa702188d1e2c89a376f605 |    | packages/functions/src/lib/learning/learning-assessment-evidence.ts |
| c16006cd0e9b4a9020fef802d3c8638eba9fd9719a4c96edd6277f9ce479a42a |    | packages/functions/src/lib/learning/learning-assessment-persistence.test.ts |
| a85d9e861db92c75434868d2e80d1a43ada390424d52c2778ea9021e5f192621 |    | packages/functions/src/lib/learning/learning-assessment-persistence.ts |
| 8fe005b86771c628d56012d35a5ca97126007bf72e422264c378b59786519ce6 |    | packages/functions/src/lib/learning/learning-classifier-input-review.test.ts |
| 034ca696ea9648c85badade1890d0369739332dbbc88005ebe5cba586aa9b2e2 |    | packages/functions/src/lib/learning/learning-classifier-input-review.ts |
| ef669d3514e61c1ad6b4dc547c0fc3b7cdfdeeec7645f423e2681a93de0715d5 |    | packages/functions/src/lib/learning/learning-classifier-v6-budget.test.ts |
| 93b5502a66ce83d95c2087887c037d1040fcf69e27366bcb68fab92281943b48 |    | packages/functions/src/lib/learning/learning-classifier-v6-catalog.snapshot.ts |
| 6905f704827601e331da9101e41dcb52eebac57aa4143e069a3d27140665860e |    | packages/functions/src/lib/learning/learning-classifier-v6-run.ts |
| d7e641d0c0da7af5aced00c33c8d6ad78abf1492f55cc2c37287b49dfe522092 |    | packages/functions/src/lib/learning/learning-classifier-v6-schemas.ts |
| 47a59e9fa098ce8894d69340646ef7fd6c6c0be69ab08aa2fcb01e90faeab0e5 |    | packages/functions/src/lib/learning/learning-classifier-v6.test.ts |
| 03999dd4f034b02546b17cf932f1e4c5921b6c08c382a8a566429141a1aad395 |    | packages/functions/src/lib/learning/learning-classifier-v6.ts |
| acd8bc3c85c83114e93d61af8a7415a0f1c9b512354a6b804c1f266ef0a82225 |    | packages/functions/src/lib/learning/learning-concept-assessment-schemas.ts |
| b042e77051ba2069bd041da03d76a52c87a2fca10fa8da394c3b59df536661fe |  M | packages/functions/src/lib/learning/learning-concept-assessment.test.ts |
| bd574e1af0348d2eb8e818ce39250491b5cff20c6aca0b21be44ff2c1e400547 |  M | packages/functions/src/lib/learning/learning-concept-assessment.ts |
| 36ef8fb1ff5c5d1c5242a436368bc4bff115bee21d3b90e34e1216c86284b00e | ?? | packages/functions/src/lib/learning/learning-concept-tag-audit-admission.test.ts |
| c802943a1824b381e8288456a6e15d90a05e69e369a06bae7e12817aae5b9818 | ?? | packages/functions/src/lib/learning/learning-concept-tag-audit-admission.ts |
| 1029e25a74895b858018abddfad5c2286145f87273069dd115df24aaf4e48654 | ?? | packages/functions/src/lib/learning/learning-concept-tag-dispatch.test.ts |
| ca5a6d73e17f12c6a5b885e73650805bfcc951223a27538c82a941b3ecf8b878 | ?? | packages/functions/src/lib/learning/learning-concept-tag-dispatch.ts |
| 2f9c19e6bd3fd79631de024163ce2e84183f320b82cd00162088de532ec4c15c | ?? | packages/functions/src/lib/learning/learning-concept-tag-experiment.test.ts |
| 5f3d8d12b87a8fa6234cff7fe4f3d85b573c6b3c0415edb3196013ae2987ca48 | ?? | packages/functions/src/lib/learning/learning-concept-tag-experiment.ts |
| 75df1b3bf277862fd9189b91626d43aa566eef49c0e15a2428c6a7e41e7234cd | ?? | packages/functions/src/lib/learning/learning-concept-tag-fixture.test.ts |
| a0e80f1e85586339b57caa18fa8d8e0fc5937bf7c118d85dc3369fbbf08ae789 | ?? | packages/functions/src/lib/learning/learning-concept-tag-fixture.ts |
| 9fe199a91c5d509e8f2ef043cafae13fcfa9bf0116805d09996218b74c63700c | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-batching.test.ts |
| c90c686511c0f7cb2e19b4e77127e15afed782b53b0737b8ef59eb836ce06d2a | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-batching.ts |
| d85be8a7fb5c8c904cec9d463863aa316752bf3c9ff9b70e8f1d5652fe52e730 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-proof.test.ts |
| eda6528c790a8809f931c1faa9c5136a437fe3a43886da01107a434cdf970f27 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-readback.test.ts |
| 75f8e2a4aecb2a247136bddbad033437a397b4413d04a09c4fd392807567e68d | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-readback.ts |
| 3b3707b41ce465ffab5961f8c1cbcd5ff9eb77a523800a40ebf5bd8786946281 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-runtime.test.ts |
| 4169e82294342d0238c799d332a576e5c4ee85325387daff620b5a49065fd6a3 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-runtime.ts |
| e883721e4e5b0926756cbe435e18dc4cff361cdad8fda7b6249f5c426be35343 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-telemetry.test.ts |
| 37a64699dc5b04461d8af92311c5bff24c4e57d9c49920875f8c450003fb546b | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical-telemetry.ts |
| 63bc8674a5c54ca0157b3c34c74fe19e88502c28fd28427b15941cbb98b661d5 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical.test.ts |
| f92abd1157931edc7760e2ab43cb1f33a001dea790f8bd7fd5035550d6a44ad8 | ?? | packages/functions/src/lib/learning/learning-concept-tag-historical.ts |
| e4bce34e0ebd9bd837dc6e5cb380719ece064b16d18238a3285600ad8dc2edb1 | ?? | packages/functions/src/lib/learning/learning-concept-tag-langfuse.test.ts |
| 24bfea1b4803af22267898b6dd7cd76b6595ebce58b0eb7ad316cbc55007ada5 | ?? | packages/functions/src/lib/learning/learning-concept-tag-readback.test.ts |
| 08cdee4941e953d66a7b122b633ed8fc4a13e56cdbe9975794518fe8c1ee673b | ?? | packages/functions/src/lib/learning/learning-concept-tag-readback.ts |
| 534f86fbd627310fed9bd804d6562f39b5fff374dcde96e1ccd06c6945ebaa95 | ?? | packages/functions/src/lib/learning/learning-concept-tag-readiness.test.ts |
| a2bc1e8c336685ea04aaec6e2a44a1b4e5f29d525b80d5c5bc4a11176fab81a3 | ?? | packages/functions/src/lib/learning/learning-concept-tag-readiness.ts |
| 611f0060b486f509836749a1dbe6decb0e88e35c63e755018498c51ab18117be | ?? | packages/functions/src/lib/learning/learning-concept-tag-telemetry.ts |
| 1bea06c181da01c9b65b85cd003f22204f828ac44fb2ae90d2e74e2c8f2c2cb2 | ?? | packages/functions/src/lib/learning/learning-concept-tag-usage.test.ts |
| f84cb2fd0fcb35e330a0bd784fb5d67804a83628df192cf0dbee32957a3865d3 |    | packages/functions/src/lib/learning/learning-context-delivery.test.ts |
| 5c7d2f7cca025d1a3c217a83eb634a0b3d8748149bf066adbd53a1b991c1e6d7 |    | packages/functions/src/lib/learning/learning-context-delivery.ts |
| c794d61d63547193f252eb738eeccbfa1c2461378544749bb972cf1e606a2ce2 |    | packages/functions/src/lib/learning/learning-curriculum-rollup.test.ts |
| b4e3aa3ae89d6edba479b34e4e420b5fe1d88ae33438f76b6399e1c6dab51ae0 |    | packages/functions/src/lib/learning/learning-curriculum-rollup.ts |
| 9350f3515e3f1a4afc256155392e6419801b636bc46559fe6cc8393d2429b98d | ?? | packages/functions/src/lib/learning/learning-evidence-budget.test.ts |
| 16d590763535531c066033536cc2ee83011c3cba0e5e9607cded6970a6bc4d76 | ?? | packages/functions/src/lib/learning/learning-evidence-budget.ts |
| 092727b244f17ca86684c0fdfdbdddb3c5d79e8223cef0752cd80d6cdc451908 | ?? | packages/functions/src/lib/learning/learning-experiment-langfuse-transport.test.ts |
| 723b4a55c4fe543a6ae670d50566cb870f2d127eaf5dacd614b9c54e8c656fb6 | ?? | packages/functions/src/lib/learning/learning-experiment-langfuse-transport.ts |
| 24d1f1cddd01192abe0ebeb1a9b323a57f4808cce13f3745b08df32286db6966 |    | packages/functions/src/lib/learning/learning-exposure-cli.test.ts |
| 19d15d4c09dadf45d50184a4b12e794099dfb9a228c1b3da84d569f1a6bd5e55 |    | packages/functions/src/lib/learning/learning-exposure-cli.ts |
| 27696dc6b85fe40e948e7f647660bc9245b2fc4f7c07d4178ef8953699b1a0ff |    | packages/functions/src/lib/learning/learning-exposure-schemas.ts |
| 8aca877772f2e5cccfafdb7b0c80c859dc38cc10ec0f2e0b9b472f3a1c8d2819 |    | packages/functions/src/lib/learning/learning-extraction-benchmark.test.ts |
| 85ccc236e4f88464a654b2029da52a39e92231af8157dbca65f3273d3f91d593 |    | packages/functions/src/lib/learning/learning-extraction-benchmark.ts |
| 7f17f7b70fd68fc6747935299562b9a6a5bc73b8272b3e608668e61b0a74fd9e |    | packages/functions/src/lib/learning/learning-extractor-config.test.ts |
| c919b7702b099ee8adc0d5892a8a622ccabc761659cc111037fbbfde66a1d097 |    | packages/functions/src/lib/learning/learning-extractor-config.ts |
| 6570e0f02c6aaeb177fc09d2d2dd645d7e3dbbe8dff429de57af5f7f99e94dc5 |    | packages/functions/src/lib/learning/learning-feedback-history.ts |
| b79c12dad62a6121130d14c1eb968e13684014a90144ce37725e79b20a90a526 |    | packages/functions/src/lib/learning/learning-feedback-traces.test.ts |
| 2461d1d445c0239fcbd0381f31cd7789e2823e00c5e026e2e0d4401e0ae17eaf |  M | packages/functions/src/lib/learning/learning-feedback-traces.ts |
| 2b8d1a6d72270c0cb160f4a0a2c269ea7d2a621b718a88bb71dc320982022cff |    | packages/functions/src/lib/learning/learning-foundation-priority.test.ts |
| 40d2722bf869e3ad53f4e1bb31e8fed4f4e07dbda7ebe0a62d691bfc4bef03d9 |    | packages/functions/src/lib/learning/learning-foundation-priority.ts |
| f6935ca0012424ccd82ac62cedfb3fd6162c59f570da335914d2b755655a067e |    | packages/functions/src/lib/learning/learning-gradual-assessment-comparison-run.test.ts |
| f57b8b5bbed8e9cd37ca88e77d96d9ca3fc0beaa6659eb69702f6685c2e59f84 |    | packages/functions/src/lib/learning/learning-gradual-assessment-comparison-run.ts |
| a220b72ae348fb19874ebfdb54d0e7fd5147cd0be6d22fd51fb367321f320c41 |    | packages/functions/src/lib/learning/learning-gradual-assessment.test.ts |
| f209baa3587a043e77de1c8a38ea978a79dbaa8c485ac823b957837cd9aaa63f |    | packages/functions/src/lib/learning/learning-gradual-assessment.ts |
| f55b4fccff8498be89d766b0efc3f7c1771b76bf8f0786821cf1b4acf1e7f42f |    | packages/functions/src/lib/learning/learning-graph-datasets.ts |
| 18019ce0b83052854737c9e35a823f5273fe136e7e0c5c0cf1ded929a757fd55 |    | packages/functions/src/lib/learning/learning-hindsight-native-pilot.test.ts |
| 2cface1491462f93e9e5bef834d03e1250ae77760f6ac9dd7dff95530ee35fd1 |    | packages/functions/src/lib/learning/learning-hindsight-native-pilot.ts |
| 59eabfdc85f584637395d00dd5f4005ddc1be5142b2d2926c684c3f65dcdc150 |    | packages/functions/src/lib/learning/learning-hindsight-reflect-receipt.test.ts |
| 26316a67dd56920eb0ee0581a80f83931fe0d517e6f4e07a24f02a0adb12ce1d |    | packages/functions/src/lib/learning/learning-hindsight-reflect-receipt.ts |
| 3ef14b48c87f8532e65a5817edcb291e1a34926787a11264954e02d40e6e9c28 |    | packages/functions/src/lib/learning/learning-hook-context.test.ts |
| 98801e3c369541bda72e80b2c77635e79ebecc69e98d9582a908c10c8360f251 |    | packages/functions/src/lib/learning/learning-hook-context.ts |
| bcd21d44ee9d0c100dc89bd487835f424a53cffca7657a7b9b6c4fda78c77a3c |    | packages/functions/src/lib/learning/learning-hook-delivery-probe.ts |
| fc4c6bec2a825725863caa509f5a23912c5dfee5c3ed4ed03957b84411fd0c11 |    | packages/functions/src/lib/learning/learning-hook-event-store.ts |
| 65640acba82821bc56de455c697572ae360e2efc28500641bf25f0b5cff91fa0 |    | packages/functions/src/lib/learning/learning-hook-health.test.ts |
| 794e4fe033233b361a836b830bf130e6049c68511af198b93781492395920430 |    | packages/functions/src/lib/learning/learning-hook-health.ts |
| 91d80c60df91e281c4894423844a13958f553dec760ee33ea759ea6c368d9697 |    | packages/functions/src/lib/learning/learning-hooks.ts |
| bf3b1e88d02eac6807b072b3f17fe3dce796783453add4551475d79279cb8771 |    | packages/functions/src/lib/learning/learning-incremental-assessment.test.ts |
| 416d3d086f3957c49b7feff7dc752eb1a849a283a7586e1d42bf6f10c4b6b6eb |    | packages/functions/src/lib/learning/learning-incremental-assessment.ts |
| c29c1fe36ef7999bb0c4a93b3524e848b3057709b173a39da4f4df210d3fb27f |    | packages/functions/src/lib/learning/learning-incremental-grading-experiment.test.ts |
| bd4deb83ed25707fd16cd6bca69cb1baad7dbaa3529dfe34736c12a6d7968ca7 |    | packages/functions/src/lib/learning/learning-incremental-grading-experiment.ts |
| 987895c6e66c0b53aa5a07224646cc76f71cbaa5d27b9aa729bcf59c460be9eb |    | packages/functions/src/lib/learning/learning-incremental-grading-langfuse.ts |
| d37651bc0e7d51f103ef6609e5b3e30fd2f32a74fc3f0013047c2bef698129b1 |    | packages/functions/src/lib/learning/learning-incremental-grading-store.ts |
| 398cb4b9b3349644c56b624705b0401a8a5bc98e81ea177b66030f4c6ecbcd6e |    | packages/functions/src/lib/learning/learning-index-admission.ts |
| 288f5ca1d6d4e7375bbbc143be7c886446fe958d6492d144c29078584e122648 |    | packages/functions/src/lib/learning/learning-live-catalog.ts |
| 9946a0da199c3dea922fe92c0f33b9f8dc29a2879041406a52c0c88facbb03d6 |    | packages/functions/src/lib/learning/learning-live-feedback.test.ts |
| ab51f79fbd460128f2e906c7515480f6f56f1e114faffc20375d08487bd6b37f |    | packages/functions/src/lib/learning/learning-live-feedback.ts |
| 487198ae0291a3bff8838d5e12bf8ecae139b4c4b9757adcdb33a408203c196b |    | packages/functions/src/lib/learning/learning-live-hook.test.ts |
| 6c2bdee9d575e1615ed9ac6476f095c7d6e2e363058562a668eac3b085f0a477 |    | packages/functions/src/lib/learning/learning-live-hook.ts |
| d36034b0eafd7c33c1b797bd83919990c686164a65bff4098f95f16704b0c7ac |    | packages/functions/src/lib/learning/learning-live-incremental-variant.ts |
| 12e9c74113e49148280082f1341ebd64d34f1cbed0012e12f73972eed0b707cf | ?? | packages/functions/src/lib/learning/learning-maintenance.ts |
| dac65beb6e87af2e01ad52625b28cc4b78ddf9bb72ebff977a5fcba2d8696f50 | ?? | packages/functions/src/lib/learning/learning-mastery-model-comparison-langfuse.test.ts |
| ea3c10087ca24418facde7b87cc41d90f3f1c9b4fc650d99eff63280a3b851cb | ?? | packages/functions/src/lib/learning/learning-mastery-model-comparison-langfuse.ts |
| 3f904b52389c482399ff4b27a7563d8dacdc7f466988714e20e5568dd92ec270 | ?? | packages/functions/src/lib/learning/learning-mastery-model-comparison.test.ts |
| ce2c56ad19bfe0b18d98670a1be1a29fa31893cc41ea1c4bcaa047b389052b3d | ?? | packages/functions/src/lib/learning/learning-mastery-model-comparison.ts |
| a689a2e3513cbb991379344f474b0cd4200b03fc2070c6aec8d68b2aa806d59e |    | packages/functions/src/lib/learning/learning-playground-archive.test.ts |
| 6edebcc234995caadda19858055770574c65a61836d016c5313708332d904eaa |    | packages/functions/src/lib/learning/learning-playground-archive.ts |
| 58a905cea6a407c901acae6585b84c6ffff973e0933256ed6e5278384f3d9a4b |    | packages/functions/src/lib/learning/learning-playground-retrieval.ts |
| 3ad63515bee127618b9df76eb93fdb2e92fc542be43a18ad8d034c2362e5fed1 |    | packages/functions/src/lib/learning/learning-playground.test.ts |
| 9a14522ce5a6e700dbf2ebbdb0950845083815a0774c79f2ccc69bc45dccfd73 |    | packages/functions/src/lib/learning/learning-playground.ts |
| fdaaa75a8214820df92caac2d7cce43906427251e392c8e2e43fe6af14d16cc6 |    | packages/functions/src/lib/learning/learning-prerequisite-selection.test.ts |
| 278069435051d02c59a8e50ec2c44afdd70ccd354d53382e2dbc02ea69ff9e8c |    | packages/functions/src/lib/learning/learning-prerequisite-selection.ts |
| 8b2f7824e1143f0920bb9a30ea0d66e16647d2ed3a135542a629aaffda21386f |    | packages/functions/src/lib/learning/learning-prompt-ab-langfuse.test.ts |
| 53e1e7f829a153b1061b1bc6dbdcb68a2f09e323a8e7fc1e43478c14bce3ea41 |  M | packages/functions/src/lib/learning/learning-prompt-ab-langfuse.ts |
| 24d1c31b4c3c6335fbbbd5cdcd4a3b5b4d136f26a4fddfbbdf7441d6e64b8b2a | ?? | packages/functions/src/lib/learning/learning-prompt-ab-separation.test.ts |
| 67dbcc2bbbf914b671aa090d0917ee707cb548bb3420f10e311543c2d1025d5b |    | packages/functions/src/lib/learning/learning-prompt-ab.test.ts |
| 30be0950c8a67b8f54a9e923e63c22d107e4f96ac51462ef8e7434a3e13439e4 |    | packages/functions/src/lib/learning/learning-prompt-ab.ts |
| f0bd373a32d6fbbb1a7a243304fa3fb4578af3753af29549d05919f24f4d9b90 |    | packages/functions/src/lib/learning/learning-reactive-consolidation.test.ts |
| b0ed7d379ba7de66ca82e2e977df383e888657eff9f7c4fa17d6d3ba12393512 |  M | packages/functions/src/lib/learning/learning-reactive-consolidation.ts |
| f38132ebaf5b0948335797498440ee56edba0ac2f88bb7a6051799f79d5e0216 |    | packages/functions/src/lib/learning/learning-reactive-probe.ts |
| d1ffe821436e040dee9fbc0ee48562925f64dabde59ea0a6892f0bc60af6bd7a |    | packages/functions/src/lib/learning/learning-seed-v1.test.ts |
| bf39e847e8c53d0f91dab96b205e3dca1404c32977d22033251a776db22eab91 |    | packages/functions/src/lib/learning/learning-seed-v1.ts |
| 7eca0d2f965066d715023370a8487b1c5e67ef892137433a475cef0d89bad5ec |    | packages/functions/src/lib/learning/learning-semantic-index-tokenize.py |
| 94d49b4820f056eb62a5642d425b37da43f70f6d786b68ddd1b9a7c6d7cf0a90 |    | packages/functions/src/lib/learning/learning-semantic-index.test.ts |
| d3d6cf0ffda09fabba73cc59003aa3c642bdb5400ab8c05ed8c1279cec27e461 |    | packages/functions/src/lib/learning/learning-semantic-index.ts |
| 1a795bfffec27f76fb01a2981c183fa115c300135618d7b92cbe4fae4d140eb5 |    | packages/functions/src/lib/learning/learning-teaching-default.test.ts |
| 567e4ca126249078190e619549350d8a2dd45a65996ed27fca7d2dd3d6f509a4 |    | packages/functions/src/lib/learning/learning-teaching-default.ts |
| b2332f6ccbbb0c5ced1025f39395ccb6b1e95647bfd41c6e23b9fed680a116e9 | ?? | packages/functions/src/lib/learning/learning-telemetry-admission.test.ts |
| 0f20e1918f484815bc37282e3045b747f85c1025b2a863ea561c8c86d22874c0 | ?? | packages/functions/src/lib/learning/learning-telemetry-outbox-integration.test.ts |
| 9e6ec5e5b98306402442b2dfea371eb507493c1b97766e7d7b7983a2129cdc7f |    | packages/functions/src/lib/learning/learning-three-step-proof.test.ts |
| 1e065055cea612296dadb65a89da11a01db6228eaaeeb6ef3a0c5138a5dd184e |    | packages/functions/src/lib/learning/learning-three-step-proof.ts |
| 4ac4c624ee59978a0d7b1425b42d3cd317c55316c302316cb9f192ec34a393f1 |    | packages/functions/src/lib/learning/learning-three-turn-context.test.ts |
| 9821e39e2aaf54f588b78ebb64efbebf2dfc78d651a6713bf495fa2f400a5d21 |    | packages/functions/src/lib/learning/learning-three-turn-context.ts |
| 3fa10f72859dfc4e69966f217beea33402cab1d20dfdf9cd4cfc9f7efee66180 |    | packages/functions/src/lib/learning/learning-turn-context.test.ts |
| 66059e503002f6ac8441bcf7f78c3370aa6d494c2d026a759c9e13569c68476f |    | packages/functions/src/lib/learning/learning-turn-context.ts |
| 27ce041782c63efaac4acc1af8b6f458eade7a980518d9fec4ecdeaa34b6904c |    | packages/functions/src/lib/learning/learning-vector-turn-schemas.ts |
| b511a4d7348bb37aad8e146dd8263d0b094fa16fc9ef3a9a2576e5e4b814a816 |    | packages/functions/src/lib/learning/learning-vector-turns-hardening.test.ts |
| 04db4b78955d3a82d3c5fcf0df0f89de810bcf283f5bb89e198a95ab55f045c0 |    | packages/functions/src/lib/learning/learning-vector-turns-incremental.test.ts |
| 9a1cb9e2454c35e63b40e3e9a4ced52ef4d3c8dae9418371a486940e020a5eac |    | packages/functions/src/lib/learning/learning-vector-turns.ts |
| ec12dce241842122f739b7b590fc7d121d760ae3b44f80bd1ac0217e05257940 | ?? | packages/functions/src/lib/learning/learning-worker-runtime.test.ts |
| ab8e061364bd2c5dff5ee63d44a40acea9b05a93c92f0a29e052fd6ae1ed9a5f | ?? | packages/functions/src/lib/learning/learning-worker-runtime.ts |
| 713b632d819619cf6a015122867b1d61705eb82632da5288ca503f633c32d8bb |    | packages/functions/src/lib/learning/lossless-archive-files.test.ts |
| 3b53063073540d78cc5e34bc24678619d1e303676d8f97fad2c9fedaca5c988d |    | packages/functions/src/lib/learning/lossless-archive-files.ts |
| 0339f491dba11a6e44f5fe8e5b829b8dec4d3fded0d151a2a727aa6818e8bb52 |    | packages/functions/src/lib/learning/lossless-archive-references.test.ts |
| 0d391e3bae65269bfbe5f8cdcc46826a321024d2ad93356477b18855b09652e4 |    | packages/functions/src/lib/learning/lossless-archive-references.ts |
| f5c7ef3d4e873fa2161b9e38c0323dd0d81548186f4c623086c198aced1da290 |    | packages/functions/src/lib/learning/lossless-archive-schemas.ts |
| cc078082a0e1a9c54ec487fc95616ecb727baafbfddbc40ba4e462f8191622d0 |    | packages/functions/src/lib/learning/lossless-archive-sqlite-concurrency.test.ts |
| 70d6afce42eaaa42c76dfb3525f800afc6b178b5b7725b3216f6ea95b3bebdbd |    | packages/functions/src/lib/learning/outcome-steering.test.ts |
| 0786e6a9317b3a3199067e8870f2bc975783626dbaf7eedfb44961ddd8779f48 |    | packages/functions/src/lib/learning/outcome-steering.ts |
| 526b5ea639caa38ce6a9973f26a21e72f64d482ebc0fa7eb125418f9653036b1 | ?? | packages/functions/src/lib/learning/telemetry-outbox-import-guard.test.ts |
| e3663bea484ce8df5d9fc6a127eb2173170d460056bfef7ad46ef6e1c88c2e41 |    | packages/functions/src/lib/learning/transcript-archive.test.ts |
| f28ae77c51ae78cb8ebcc388c283e264ead62e5d8c16e35076faa2bff15c714e |    | packages/functions/src/lib/learning/transcript-archive.ts |
| f24fee9b1641c7901b59d8f5470b518a1e864e08131fafd34867df62ad14049c | ?? | packages/functions/src/lib/llm/langfuse-generation.ts |
| 897a9bb77a8a3dc94cd1a9616f508ae518530a928c7aea2f8b6c13259b76e708 |    | packages/functions/src/lib/llm/llm-limits.ts |
| e541a8717eecfe5ff3b64c9d9fe3c9f39642372da629496965267935aa0a20ab |  M | packages/functions/src/lib/llm/llm-service.ts |
| e5bad8aa36ebb847194e9d3df2211d0bd7da365e609bca280fa2d284c9389dba |  M | packages/functions/src/lib/llm/model-catalog.ts |
| 201becdd6d4b96f5dc557da0962e280ccae0cd290b01c8d6bb9e8d7079cef8ce |  M | packages/functions/src/lib/map-with-concurrency.ts |
| 27a4c1634d3ce40e6bc4db15cc22a8989428173cb3d683f6bbb0766d3357a7b3 |    | packages/functions/src/lib/runtime-flags.ts |
| e8d5eee41630aa7ec77bb6e135fbf8fca2aa51947c4bc7dcc4248e7113e36265 |    | packages/functions/src/lib/workflow/rolling-queue.ts |
| 7e3ce3a158f0558098a8e3c715ee6d27ced1799f7696cd39a63ca91fe1d21c17 |  M | packages/functions/src/lib/workflow/run-recovery.ts |
| 301dd2b8062ccd0f3660480ed2777b41021167075b6ad4d2c541ac326c397e1d |    | packages/functions/src/lib/workflow/workflow-runs.ts |
| 18e966ebc7ef80cb6539ab1302cfe761618fa02126cd6d5f276827e9bcf039f3 |    | packages/functions/src/services/learning-cli-vector-e2e-service.ts |
| ec27c54b859c2d5c4e6ef871d853bd700a560da53854e4c5dd992694d008db80 | ?? | packages/functions/src/services/learning-concept-assessment-decision.test.ts |
| 915c8236830dbb729ff1055f9cf1a9fcc1c9265d668781be96d9cedfa5c8a5ce |    | packages/functions/src/services/learning-concept-assessment-model.test.ts |
| eedf5e1563cedc3f891c3f3d0e0939edbb290fcf620f97792e65411a244b6d91 |  M | packages/functions/src/services/learning-concept-assessment.ts |
| 82cbddf6669dbc4157d65428ab21b78295d23308daff2bff4b7e56f57c4a9325 | ?? | packages/functions/src/services/learning-concept-tag-chunks.test.ts |
| a77d4ef134cb9337528006be86c8ffd0fc02c02367111ee3124f36ed9c7cdd65 | ?? | packages/functions/src/services/learning-concept-tag-chunks.ts |
| 351327bbfed0971014091c7a14ae0f6d92c9c112d3ae902615488dec64d9656d | ?? | packages/functions/src/services/learning-concept-tag-store.test.ts |
| 2315a1ae1584977a7ac6f1bdc8684b0011cfbd3304cb50d794e5a0415280a780 | ?? | packages/functions/src/services/learning-concept-tag-store.ts |
| 3b5f2f9b39380571284c81feed4abeb7dee007d559553cc92e0c95bfba104f21 | ?? | packages/functions/src/services/learning-curriculum-generation-store.test.ts |
| 41f298609706e54dc03f5e9d5b73de70be01850403362eea20c4f86844809787 | ?? | packages/functions/src/services/learning-curriculum-generation-store.ts |
| 982e279a8bc1f77213b26f47a17a8ee28dbb5474d177357a90261cf806606187 |    | packages/functions/src/services/learning-curriculum-scope.test.ts |
| 11488549a1456c05393f48f47cf89d05e204d190e7070556f194131c99cf415f |  M | packages/functions/src/services/learning-curriculum-store.ts |
| a168eab35d01ddea33613c9950aeaacdcf769c13411a9dcef9633e9e24e578b3 | ?? | packages/functions/src/services/learning-curriculum-visibility.test.ts |
| 81390835323d18c3f3a305a33e05755944bc677d3a5de3e08f6a1148f30d5f64 |    | packages/functions/src/services/learning-episode-store.ts |
| a192c15aa27ccbcb2e50affe1c314075a29ecc9f52608ef879833d89bcb4e1cf |  M | packages/functions/src/services/learning-exposure-ingest-service.test.ts |
| ec72d04072457cc91784546ca61782529cdb7808aa94e9b10eafdce13851cd70 |  M | packages/functions/src/services/learning-exposure-ingest-service.ts |
| 682f3397a388848b69276b9bf9217bd986bcec661fe0462b754a3e881357e4d8 |    | packages/functions/src/services/learning-exposure-service.test.ts |
| e4277606da885a819d24aaa9d53995e14be3b894ebe75083671d55b7a02f0320 |    | packages/functions/src/services/learning-exposure-service.ts |
| 9472732a76bf8e0245661e79fb5e304106bcb0abeb51be39125823e1bb05503e |    | packages/functions/src/services/learning-exposure-work-service.test.ts |
| 4e3650ea2947706f42a8b0f67cecd4a81d905ddcde42e5d775c7a0ef7a45f625 |    | packages/functions/src/services/learning-exposure-work-service.ts |
| 1a3450900cf7e774f76efd8a9ce94a69029557af9108d51cd1001e8d865ea91b |    | packages/functions/src/services/learning-hindsight-consolidation-trigger-service.test.ts |
| aeb7ac93703937bd43e00de4454c43ca7c9f2c483dd7717504c1db0948398482 |    | packages/functions/src/services/learning-hindsight-consolidation-trigger-service.ts |
| e31955e42b5e0837921e4815c56e0a99eee1361150bce648ed44680e4189f8c5 |    | packages/functions/src/services/learning-lossless-archive-isolation.test.ts |
| 26af683cdf36f473e2542aa1a8f4f91c6b4b370e24db93b6e6e0a335df17e704 |  M | packages/functions/src/services/learning-lossless-archive-service.test.ts |
| 965b721af85d946d44829c16ed4c9a6724de91feec72417e7cb4d59f3b0ab7a5 |  M | packages/functions/src/services/learning-lossless-archive-service.ts |
| db2fe8592f89cba5bac16162543bacbe8cc9bc1373f01a17e1303cd209645083 |    | packages/functions/src/services/learning-lossless-archive-sync-service.test.ts |
| 8463d6bb49fe958f774b6c6afd6f1d7eb700bcd45b122620f260253bf9eebfea |  M | packages/functions/src/services/learning-lossless-archive-sync-service.ts |
| 19f51122701918fd3c7ea3035191e6720a5686b93e9fd3fcaaa250bf1ae99cf9 | ?? | packages/functions/src/services/learning-lossless-sqlite-staging-root.test.ts |
| a94d6c7e10bab820877e7fdac71faaa53d536bfe8981092d78fc9b94d481afd5 |    | packages/functions/src/services/learning-semantic-index-probe.test.ts |
| 740c38bb5d964ee521d0e1d1f6e45519a2afce55ce796ee5696a877c326aee12 |    | packages/functions/src/services/learning-semantic-index-service.test.ts |
| bee309675b803d42f575f022b19e42233e1f22f9deacdd0dd36f41c37217eb33 |    | packages/functions/src/services/learning-semantic-index-service.ts |
| e29c0f469ef61a3c030ffbf29b953498b51dab70334b3d145a66c8d358f6248d |    | packages/functions/src/services/learning-transcript-archive-service.test.ts |
| af01065a27718a5bcb22bc33802b81a1864cdeec3e05994f69e78e158bd3d545 |    | packages/functions/src/services/learning-transcript-archive-service.ts |
| 413183240a4f310977e82b1c9e33631fe8870d141a4d08429303fe91ab04dd0d |    | packages/functions/src/services/learning-vector-turn-service.ts |
| e705777f3a0fff46ffa3a4b9b9c2b836a40382b47bd9c7905a4dd192c93b149a |  M | packages/functions/src/services/llm-service.ts |
| 54a660b6306cae12ed10f256ea262712ff46ce8a86f8e4d00afd586ad6dbf81d | ?? | packages/functions/src/services/telemetry-outbox-service.ts |
| c484f487010950c1cf4b95e72bae7584ebcb76bb12ca0b76164b8082b698eccf | ?? | packages/functions/src/services/typesafe-decision-service.ts |
| 16d1106c04ba0bd8708af8bfc424c8eaf56e0229c73d60cc015a1d98df8b4298 |    | packages/functions/src/wirings/http/core.http.wiring.ts |
| d3373729428578e662417b484d09e311fe9ea79944bb26c59950ac61accd9ec5 |    | packages/functions/src/wirings/http/hindsight-agy-openai-bridge.http.wiring.ts |
| 8edb56c9f574cc9a0b3536da2edc94dad8027badf2261ac8742f509d3c615d7e |    | packages/functions/src/wirings/http/learning-playground.http.wiring.ts |
| 05bb614227d42f667b63d144798de1d210d8a7ba56aa054c8add04b7068e97f8 | ?? | packages/functions/src/wirings/learning-concept-tag-experiment.workflow.ts |
| 201106be45d0d1799478b63bc6d7430431f8a3c1b8e03396ce52793facadaff3 | ?? | packages/functions/src/wirings/learning-concept-tag-historical.workflow.ts |
| 63c9351050434d29db14b794d104b8fc4261afe8fe214ccd3ba51b3b8b7302cd | ?? | packages/functions/src/wirings/learning-curriculum-generation.workflow.ts |
| 115aee7511a9b23cf067143da03f22ada848f0d8551f6a0999545ff30b7df6ff |    | packages/functions/src/wirings/learning-incremental-grading-experiment.workflow.ts |
| b5eb160dc23833224132039137bbfc988e17c20b55062519f143427a6c61ad33 | ?? | packages/functions/src/wirings/learning-mastery-model-comparison.workflow.ts |
| 4ed073ba5e5efe1d3b92850d7d4a254ee14647f627c085d52f5a0815b3a9d574 |  M | packages/functions/src/wirings/learning-prompt-ab.workflow.ts |
| b6d13ee4288c53c87d2de5b944e069cd72b288782ba922afbb0ada017f3ed6b8 |    | packages/functions/src/wirings/learning-reactive-consolidation.workflow.ts |
| f29e4cd62af2d3376c50bae95d6f39a223df701af047acd7cacb8c6b24a04103 |    | packages/functions/src/wirings/learning-semantic-index.workflow.ts |
| e9577c2261013a0518a6bc5e5ba0fb032ba806d68963427170dc86d3fc422b6c |    | packages/functions/src/wirings/learning-vector-turn.workflow.ts |
| 5946d9cbe9708a87116f8715f7f81aff51d9b5b24530538491a424b0067e4f2f | ?? | packages/functions/src/wirings/queue/learning-concept-tag-audit.queue.ts |
| 5d853a808e0577cace3666430fae5128c2d54c8a4f5038ffc738feb9cc0f878f | ?? | packages/functions/src/wirings/queue/learning-concept-tag.queue.ts |
| 93d9d09d5d226afb736772e22bdedee0b285dbee617dd2c7b6e03f12b6344212 |    | packages/functions/src/wirings/queue/learning-incremental-grading-experiment.queue.ts |
| 42d313e5c88aa0910d4102b116a683508db10b167bc046faa99e913fa23ffd08 | ?? | packages/functions/src/wirings/queue/learning-maintenance.queue.ts |
| 33a1fdde2b7116042146ba290849d4f2018151d3d3734effcf835e4f4a20d573 | ?? | packages/functions/src/wirings/queue/learning-mastery-model-comparison.queue.ts |
| 4e662a0a9db41d010fd2d33cba5e9f188cf6421c5a4f3678c345ca83a39e20ad | ?? | packages/functions/src/wirings/queue/learning-prompt-ab-audit.queue.ts |
| 17e90aabda4cbb5fa392fb67563fe22f33326cd53883f38b582921df7fdd63a2 |    | packages/functions/src/wirings/queue/learning-prompt-ab.queue.ts |
| cdc1b198e89f425c6e4547eb3895178c78d0123f5b1c0bccd5616ac1be979367 |    | packages/functions/src/wirings/queue/learning-vector.queue.wiring.ts |
| df8b5520da9341b2ae827b9d709575908f5f770f24e35e1a98b2d52b35bed364 |    | packages/functions/src/wirings/queue/learning.queue.wiring.ts |
| f5beae345c34d448e6d66be7217da6605a0f420b8e81008120bcc333cd99b32f |    | packages/functions/src/wirings/scheduler/learning-archive-coordinator.scheduler.ts |
| ede05527ec3034a82ffd6c00712ca79f458e5bdff444871f93042097efa5b415 |    | packages/functions/src/wirings/scheduler/learning-feedback-traces.scheduler.ts |
| 81b362656e6b2cd78093ba43a432be0c3e7d88264d02b44c37e0d939ab5ba207 |    | packages/functions/src/wirings/scheduler/learning-lossless-archive.scheduler.wiring.ts |
| c3e3cdd29332e4fda97b0551d0df8033c4d48e2751b49505390a677047c765c5 |    | packages/functions/src/wirings/scheduler/learning-reactive-consolidation.scheduler.ts |
| 1ce382b8fc1e02d63f504eaee241e7f50b08ad189d428916517509bd8b9e8d5a |    | packages/functions/src/wirings/scheduler/learning-semantic-index.scheduler.wiring.ts |
| 0429daa518b56faa1dcf8fccdc77bf1b3dda9d302982704860f4582cc46740f6 |  M | packages/harness/src/langfuse-export.ts |
| f29934383beb7e4839492a11d1ac91accd8bb6e90a673fec7f2975ddb5a4f801 |  M | packages/harness/src/langfuse-types.ts |
| 7f6b5baa32a1aa499fc4601c74216b8fc5425357877e2be2f747a1033fea9040 |    | scripts/learning-active-archive-probe.ts |
| 9eb7d5899b03fedfd5d64e712666c6ab1da6ccbe1f4a6b0a3fa8319b0d10cff1 |    | scripts/learning-agy-context-fidelity-probe.ts |
| 9bd8dce67ec03fe723d7d771259990a70b32b1a73eb40ba022992dad0b95052d |    | scripts/learning-claude-hook.test.ts |
| c75d934882c6229ca8932f36e78aea856c8b0b20f148584c2690504aad5594b6 |    | scripts/learning-claude-hook.ts |
| 809cf2c1ff80adfacbcb0346ded9aae2d0f60e32ff0a5ee96fb3df94a2c5118d |    | scripts/learning-context-ablation-export.ts |
| 2e3256be65893dc523004e194a2ec67c9a5208f8eb2aad7e8c108e65ad244862 | ?? | scripts/learning-curriculum-build-browser-check.ts |
| 88d10f75eb9b8ab36125cc9534c07479387165c51461edb3d6f513f182112f01 |    | scripts/learning-cycle-browser-review.ts |
| f65621c85a8735a41c7fc81e37e7b66b485355596b6170e1773d7d1b16cfbc63 |    | scripts/learning-cycle-influenced-review.ts |
| 0b647373d127a22cd8f5736ab1bdc7c01090bdf492f4a25ce8c1709b607b5012 |    | scripts/learning-cycle-report.ts |
| 5dfbf3c0a2620b8b67c0ad1c030583cf759c2acd4bcda55d2fd6049dfb351a36 |    | scripts/learning-cycle-running-report-review.ts |
| ee163446e937461792cb7dd96818afa6cd6b45105fc0864dcbcea61fbd37e49c |    | scripts/learning-exposure-integration.ts |
| 74dbe82e4eac431a1ad926ff9ae1bc2baeeaf93edaab7674f2a85769a84d6c9f |    | scripts/learning-flash-abc-blocked-summary.ts |
| 3a939a8a926c5bc355e1af0c39f1383afd7f5ce0e9c100eeaa3389847d3301e9 |    | scripts/learning-flash-abc-recall-proof.ts |
| 1a96f189cce4e372fad2faafcbfbc650eeb23b02bd4037a19f19de4acfad5bda |    | scripts/learning-flash-model-ab-preflight.ts |
| ad4ade5d5ca0f59559dd21e61fe0fe57ea38c4578a1e357ecd9d0bc9aac68c7b |    | scripts/learning-freeze-blinded-prompt-ab.ts |
| 266d0892cd2f3ce7f97c6cccd3a016cc20abe4346d9852d00de819b69f36709e |    | scripts/learning-graph-dataset-browser-check.ts |
| a811c3d2b3a265b4da92bc7512fd43e62d718a98a0fa09fc4e76f6f5a079771b |  M | scripts/learning-hindsight-agy-runtime.sh |
| 3736c1a0899c7312f64795579a08fc25ede8ec97fdf7c4ed1386b592938483a7 |    | scripts/learning-hindsight-cohort.ts |
| afc6ff87cca6dc85a90f51a41b460da61d775acc234a44eda04533f1045ee0e8 |    | scripts/learning-hindsight-consolidation-trigger-integration.ts |
| 4413fc627beaf7cc7cd45703de2f5b2476ab55c0445c130b6cd798f480fc35d4 |    | scripts/learning-hindsight-native-pilot.py |
| 91b47f1e4a611df1b2a9bdd9a1fc8605aa10099238f20f6da8dde2efd5329bd4 |    | scripts/learning-hindsight-native-pilot.test.py |
| 9f3dd99959eed85d0d987370c2a2cd762c206ebc1292d0025ed45de96b4f3203 |    | scripts/learning-hindsight-pilot-prepare.test.ts |
| aa04d58cb217a5f619c9ba2aafe466ee8b24c12750d1a225d3c6ec044bc70754 |    | scripts/learning-hindsight-pilot-prepare.ts |
| 83ad5fc99880b22b862f1311616590b9e8a18bd445d65b552173862812158d64 | ?? | scripts/learning-hindsight-runtime-lifetime.sh |
| 3e6971acbd625ab7e53385c129bb29f82a7c9681d330bd002e3106724bbb6b55 | ?? | scripts/learning-hindsight-runtime.test.ts |
| fbd65af958897811a9108d76633618e2a18ad21fcca2438409abcf11c605d55f |    | scripts/learning-hook-recovery.preload.ts |
| e15283ae58676bf62696a3b2a04a68f0b86d72b561838feb2352b7f0f62a0199 |    | scripts/learning-hook-recovery.test.ts |
| 238c7929d95db5484004c7b9c2c3ec26f5a6b247971c5c347635e73525f3ae2b |    | scripts/learning-hook-recovery.ts |
| 1305b4cb290ea9682fbe3860f4ec6f9692ca9eb49b8e15e348eaf896fa23233a |    | scripts/learning-node-evidence-browser-proof.ts |
| df2d0f729fb8b868c5a062cc40271063979966772fcd7b996564ae4d812c8d04 |    | scripts/learning-node-evidence-selection-proof.ts |
| dc24b7e02f74ebcad41b42e7ca3e968b08f75f5be48865138221335fec00da13 |    | scripts/learning-playground-browser-check.ts |
| 817a28c6b978bbe50bbe985764de88f2edf56bb183c5dafdabf4fbdc84dfd435 |    | scripts/learning-playground-export.ts |
| a4929c1595fbf7c84394d3f5eff9e62e5160f803e109c45e63f3f609f2ad92e8 |    | scripts/learning-prompt-ab-dashboard.ts |
| d3a03d5e33d4ca7951bc2e55c9fe7091658c8a75f7c9b4b2fc8c247183ca1064 |    | scripts/learning-record-blinded-review.ts |
| 80fd2640e4b883f444274a5821c044cc1983bcd58cbae4b38e079f427ccaae4e |    | scripts/learning-seed-v1-browser-check.ts |
| d18158a21850b174b2d3648b73a4d54431896c3226a3324ba4f72d4eda71696b |    | scripts/learning-seed-v1-hindsight-consolidation.py |
| 26d82ce93a17d0497311587c976354b7e4e88300e548cd60ae1b6b5bd0398767 |    | scripts/learning-seed-v1-hindsight-consolidation.test.py |
| 783d61daaecedd2a5ea516fc4d7ccf19cdd82a6047cffc84608c79d38c46b832 |  M | scripts/learning-seed-v1-hindsight-runtime.sh |
| 82ac6226deb9c15988d12b8faf4ec2c27ca8e541745cea9290349fc75d841fb8 |    | scripts/learning-seed-v1-hindsight.py |
| 0167a715d48a6baa0158b2fc100683385d1ec21ac1c0977546cf2da7407e3966 |    | scripts/learning-seed-v1-hindsight.test.py |
| 63f4d804585c3faaeb8f05d9d135053c3058dde77df1d8b3521fc9b4dc5f0cd9 |    | scripts/learning-seed-v1-reconcile-hindsight.ts |
| 666f5d3450919d7dcf0a58694ca5bb6348723501c35a74a3dec0a328255fd61a |    | scripts/learning-turn-count-audit.ts |
| 7aa9cc38bf3917e77e1e7502df4b5c6311e434d2d64d3989028ba2e345a6f6db |    | scripts/learning-vector-browser-review.ts |
| b575f1cd7d652c19dbef85002cefc166164c7758588c4940cf31a1b474bbde87 |    | scripts/learning-vector-dev-deploy-monitor.ts |
| 598b3c768cad9187630120a583caea2471a68927c63531666675a4f832258311 |    | scripts/learning-vector-query-embeddings.py |
| c2432a15a41d42ccc3002fd25e373ed8646b37549d7ed0e5553c51e7b367692e |    | scripts/learning-vector-rolling-audit.ts |
| d458ea54691a094d4196dc689040c986ef514f492c14af9a47e29e75948b6bad |    | scripts/learning-vector-rolling-monitor.ts |
| c199ff3bbd858c9784300a93621ef9edfbc30453a7e895a8c7aad52b38206c6e |    | scripts/learning-vector-selection-audit.ts |
| 3da60076037acf5b732e162003d4f7815631b0f3ab81e56bae90836e613c7d69 |    | scripts/learning-vector-turn-probe.ts |
| e40401b1618d32a0efdc64c978a3c9f3ed7bcb6dabf0bcdb1de5be63af6e96f4 |    | scripts/learning-vector-turn-report.ts |
| e6b42b2e1ffee884c6c7a80a2e7f77e2d03c287661d7b9368f9bd4bc9dc54acc | ?? | scripts/learning-worker-build.ts |
| 865c174f125123a8fc028109c5c2cfbec536a877282d86c770c2427c32c23d3c | ?? | scripts/learning-worker.ts |

## Late additions (ported after the first snapshot; hashed at 2026-10-21T22:40:42Z from the working tree)

| sha256 | status | path |
|---|---|---|
| d524be89f2611c89b69c1ff59f37d4c7fb0d9161fc833da1cfddd595cc042d4f |    | packages/functions/src/services/observability.ts |
| c031b41da4b17586a33cf8bd597b54e30ec6083f16912d81b1aae9d83341ce4a |  M | packages/functions/src/functions/llm/list-model-catalog.function.ts |
| fe6543a971bff903cb412009ed01e87b828e4c769b7fbc246b852dc30bc2aab8 | ?? | packages/functions/src/functions/queues/telemetry-outbox.queue.ts |
| 6f8db0ed27301cbf719f5ba86cd88ce6be2ade60d405cf781762bfdbcbd87399 | ?? | packages/functions/src/wirings/queue/telemetry-outbox.queue.ts |
| fb7de5a7336b73e52cff1bcd0df45cedcd01bd2e6a0789dbed9e9078048216eb | ?? | packages/functions/src/wirings/scheduler/telemetry-outbox.scheduler.ts |
| 7c3332efa31adacdd0d7a44388a3a7ecc6f0d6fb43e535af7e4c81cd48f0cdc3 | ?? | packages/functions/src/functions/scheduled/telemetry-outbox.scheduled.ts |
| b53e68d416b4878791814402548ebf5023cbe5e2b39f9de1f8a56ae98c427e51 |    | ops/openclaw/learning-archive/spool.ts |
| 01dea5a5280ad52fddd087b32c67b02573ae0ea920fc521edb71eb7982447b09 |    | ops/openclaw/learning-archive/history.ts |
| bfd84a3d81521d5040fa102c474a57043201989db1ccd003502dd1d3f0219d02 |    | ops/openclaw/learning-archive/index.ts |
