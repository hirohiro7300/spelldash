# 訳が曖昧な語の洗い出し（BACKLOG G1、創業者確認用）

> 2026-09-21 作成。データは変更していない。置換案に ○ を付けてもらえれば反映する。
> **2026-10-02（Batch 35）**: 創業者の「自走して」を受けて §1 の 14 組の置換案をそのままデータに反映した（jhs-english1／3、eiken4／3／2／p1／1、toeic500／600／730。office は eiken4 と jhs-english1）。§4 に、別解の執筆者（16 パック）が挙げた新しい候補を追加。こちらは未反映。
> 実装側の手当て（Batch 25）: 同じカテゴリに同じ訳の語が複数あるときは、出題文の下に例文の訳を添えるようにした（英語は見せない）。以下の 14 組はすでにこの文脈つきで出題される。

## 1. 同じカテゴリ内で訳が同じ語（14組・28語）

訳だけでは答えが一つに決まらない組。例文の訳で区別できるが、訳そのものも分けた方が学習者に親切。

| パック | 訳 | 語 | 置換案（訳を分ける） |
|---|---|---|---|
| 中学英語1年 | 話す | speak / talk | speak: 話す（言葉・言語を） ／ talk: しゃべる・話し合う |
| 中学英語1年 | 授業 | class / lesson | class: 授業・クラス（学級） ／ lesson: レッスン・（教科書の）課 |
| 中学英語3年 | 宇宙 | universe / space | universe: 宇宙（全体） ／ space: 宇宙空間・空間 |
| 英検5級→4級 | 会社 | office / company | office: 事務所・オフィス ／ company: 会社 |
| 英検4級 | うれしい | happy / glad | happy: 幸せな・うれしい ／ glad: （〜して）うれしい |
| 英検3級 | 計画 | plan / project | plan: 計画・予定 ／ project: 事業・プロジェクト・課題 |
| 英検2級 | 十分な | adequate / sufficient | adequate: 適切な・まずまず十分な ／ sufficient: 十分な（量が足りる） |
| 英検準1級 | 統合 | integration / synthesis | integration: 統合（一体化） ／ synthesis: 合成・総合 |
| 英検1級 | 難解な | abstruse / esoteric | abstruse: 難解な（理解しにくい） ／ esoteric: 秘教的な・一部の人にしか分からない |
| TOEIC 500 | 料金 | fee / charge | fee: 料金・手数料（サービスへの） ／ charge: 請求額・請求する |
| TOEIC 600 | 倉庫 | warehouse / storage | warehouse: 倉庫（建物） ／ storage: 保管・収納 |
| TOEIC 600 | 利益 | benefit / profit | benefit: 恩恵・福利厚生 ／ profit: 利益（もうけ） |
| TOEIC 730 | 契約 | contract / agreement | contract: 契約（書） ／ agreement: 合意・協定 |
| TOEIC 730 | 評判 | publicity / reputation | publicity: 宣伝・世間の注目 ／ reputation: 評判・名声 |

## 2. カタカナだけの訳（225語）

`クリック／click`、`マーケティング／marketing`、`ソフトウェア／software` のように、訳がそのまま英語の音写になっている語。曖昧ではないが「読めば分かる＝思い出す練習にならない」語が多い。IT（約60語）と広告・マーケに集中。

- 案 A: そのまま残す（実務で綴りを打てることに価値がある。IT はカタカナ語を英語で書く場面が多い）
- 案 B: 訳に短い説明を添える（例: `クリック（マウスで押す）`、`ソフトウェア（プログラム一式）`）。出題の難度は上がる
- 案 C: レベル easy に固定し、腕試し・新語導入の序盤だけで出す

機械抽出の条件: 訳がカタカナと長音のみ・3文字以上。一覧は `node -e` で再現できる（docs/STATUS.md 2026-09-21 参照）。

## 3. 1文字の訳（180語）

`犬／dog`、`水／water` など。曖昧ではないので対応不要（参考数値）。

## 4. 別解の執筆時に挙がった候補（Batch 35、137 件・未反映）

英検 5 級〜1 級・TOEIC 500〜990・高校英語・TOEIC・ビジネス・IT の 16 パックに別解（`accept`）を書き足したとき、執筆者が「訳だけでは答えが一つに決まらない」「訳が英語の中心義とずれる」と報告したカード。多くは `accept` で別の語も正解にしてあるので実害は小さいが、訳を直した方が親切なものは ○ を付けてもらえれば反映する。書式は `語: 今の訳 → 置換案 — 理由`。

| パック | 候補 |
|---|---|
| eiken5 | foot: 足 → 足（足首から下） — 日本語の「足」は leg も含むため leg を accept に入れたが、訳だけでは一意に決まらない |
| eiken5 | clock: 時計 → 時計（置き時計・掛け時計） — 「時計」は watch も指すので watch を accept に入れた |
| eiken5 | house: 家 → 家（建物） — 「家」は home も自然で一意に決まらない（home を accept に入れた） |
| eiken5 | play: 遊ぶ・する → 遊ぶ・（スポーツを）する — 「する」だけ見ると do を打つ可能性がある |
| eiken5 | many: 多くの → 多くの（数） — 「多くの」は much も自然で一意に決まらない（much を accept に入れた） |
| eiken5 | old: 古い・年をとった → そのままで可 — 2義併記だがどちらも old で一意なので問題なし（念のため報告） |
| eiken4 | happy: うれしい → 幸せな・うれしい — 同パック内の glad（うれしい）と ja が完全一致。訳だけでは一つに決まらない |
| eiken4 | glad: うれしい → うれしい（会えて・聞いて） — happy と ja が完全一致。区別するなら happy 側を「幸せな」に寄せる案 |
| eiken4 | office: 事務所・会社 → 事務所・オフィス — 「会社」が同パックの company（会社）と重なる。company を accept に入れたが、ja から「会社」を外せば不要 |
| eiken4 | leave: 去る・出発する → 出発する・（場所を）出る — 「去る」は go away 寄りで、eiken4 の leave の中心義（家を出る）からややずれる |
| eiken4 | call: 電話する → 電話をかける — 問題なし寄りだが、call の中心義「呼ぶ」と異なる訳なので phone/telephone を accept に入れた旨を記録 |
| eiken3 | plan: 計画 → 「計画・予定」 — project の ja が「計画・課題」で先頭が重なる（互いに accept に入れた）。plan 側の訳に「予定」を添えると区別しやすい |
| eiken3 | project: 計画・課題 → 「課題・企画」 — plan と「計画」が重複。例文も課題の意味なので「課題」を先頭にしたい |
| eiken3 | customer: 客 → 「顧客・買い物客」 — 「客」だけでは guest / visitor / client も同等に正解になる（guest も同パックの出題語） |
| eiken3 | diet: 食事・ダイエット → 「（日常の）食事・食生活」 — 「食事」だけ見ると meal / food を打つ。diet 固有の「食生活」を示したい |
| eiken3 | presentation: 発表 → 「発表（プレゼン）」 — 「発表」だけでは announcement（公表）も正解になる |
| eiken3 | problem: 問題 → 「問題（困ったこと）」 — 「問題」だけでは question（設問）も正解になる |
| eiken3 | hope / wish: 望む / 願う — 訳が近く、学習者が入れ替えて打ちやすい（互いに accept 済み）。wish は「〜ならいいのに」の仮定のニュアンスを訳に添えると区別できる |
| eiken3 | safety: 安全 → 「安全（性）」 — 「安全」だけでは security も同等に正解になる |
| eiken2 | advocate: 主張する・擁護する → 提唱する・擁護する — 「主張する」だけ見ると claim/insist/assert が先に浮かぶ（accept に claim/insist/defend を入れたが、訳を寄せた方が良い） |
| eiken2 | adopt: 採用する → 採用する（案・方針を）／採択する — 「採用する」単独では hire/employ（人を雇う）とも取れる（accept に employ/hire を入れた） |
| eiken2 | campaign: 運動・キャンペーン → （政治・社会）運動・キャンペーン — 「運動」単独は exercise/movement とも取れる |
| eiken2 | retirement: 退職 → 退職・引退 — retirement は定年退職・引退。「退職」だけだと resignation（辞職）も同じ訳になる（accept に resignation を入れた） |
| eiken2 | revenue: 歳入・収益 → 歳入・総収入 — 「収益」は profit/earnings とも訳され、revenue（売上高・収入）とずれる |
| eiken2 | adequate: 十分な・適切な ／ sufficient: 十分な — 同パック内で「十分な」が重なる。互いに accept で相互受け入れ済みだが、adequate は「適切な・まずまずの」に寄せると区別しやすい |
| eiken2 | discipline: 規律・学問分野 → 規律・（学問の）分野 — 「学問分野」だけ見ると field/subject が浮かぶ |
| eikenp2 | suppose: 思う・仮定する → 〜だと思う（仮定する） — 「思う」単独だと think を打つ学習者が多い |
| eikenp2 | common: よくある・共通の → 一般的な・共通の — 「よくある」は usual / frequent も自然で一語に決まりにくい |
| eikenp2 | physical: 身体の・物理的な → 身体の — 二つの意味を並べていて、学習者がどちらを答えるべきか迷う（bodily などの別解は出ないので実害は小） |
| eikenp2 | promote: 昇進させる・促進する → 促進する — 「昇進させる」の意味は受動で使われることが多く、advance / encourage を打つ可能性がある |
| eikenp2 | task: 仕事・課題 → 課題（割り当てられた仕事） — 「仕事」だけ見ると work / job が先に出る（work / job は accept に入れた） |
| eikenp2 | extremely: 非常に・極めて → 極めて — 「非常に」で very を打つ学習者が多い（very は accept に入れた） |
| eikenp2 | argue: 議論する → 主張する・言い争う — 「議論する」の第一想起は discuss。argue の中核は「主張する／口論する」（discuss / debate は accept に入れた） |
| eikenp2 | realize: 気づく → （はっきりと）気づく・悟る — 「気づく」だけでは notice と区別できない（notice は accept に入れた） |
| eikenp2 | temperature: 気温・温度 → 温度 — 二つ並べる必要はない（別解は出ないので実害は小） |
| eikenp1 | synthesis: 統合・合成 → 合成 — integration（統合）と訳が重なる。accept に integration を入れたが、ja を「合成」に絞るほうが明確 |
| eikenp1 | presume: 推定する → 〜だと推定する・思い込む — 「推定する」は estimate（統計的推定）とも取れる。accept に estimate を入れたが、ja の見直しを推奨 |
| eikenp1 | tangible: 有形の・明白な → 有形の・触れて分かる — 「明白な」だけ見ると obvious/clear/evident が自然で、tangible に辿り着きにくい |
| eikenp1 | hierarchy: 階層 → 階層制・ヒエラルキー — 「階層」だけだと layer/tier/class も正解になり得る（accept は入れず） |
| eikenp1 | exploit: 搾取する・利用する → 搾取する・（資源を）活用する — 「利用する」だけ見ると use/utilize が先に浮かぶ |
| eikenp1 | disrupt: 混乱させる → （活動・運行を）混乱させる — 「混乱させる」は confuse（人を）とも取れる。accept に confuse を入れたが、訳の補足を推奨 |
| eikenp1 | catalyst: 触媒・きっかけ → 触媒・（変化の）きっかけ — 「きっかけ」は trigger/chance/opportunity など多数の語に対応 |
| toeic500 | fee: 料金 vs charge: 料金・請求する — both ja contain 料金; learner cannot tell which is wanted (cross-accepted both ways) |
| toeic500 | manager: 部長・支配人 → 部長・マネージャー — 部長 also maps to director / general manager |
| toeic500 | guest: 客・招待客 → 招待客・宿泊客 — bare 客 invites customer / visitor |
| toeic500 | charge: 料金・請求する — mixes noun and verb glosses while pos is 名 |
| toeic500 | delay: 遅れ・遅らせる — mixes noun and verb glosses while pos is 名 |
| toeic500 | increase: 増える・増加 — mixes verb and noun glosses while pos is 動 |
| toeic500 | task: 仕事・課題 → 作業・課題 — 仕事 invites job / work (accepted, but ja is broad) |
| toeic500 | position: 職・地位 → 職位・役職 — 職 invites job; 地位 invites status / rank |
| eiken1 | abstruse: 難解な → 難解で晦渋な — esoteric（難解な・秘教的な）とほぼ同じ訳で区別がつかない |
| eiken1 | castigate: 厳しく叱責する → 公然と酷評する — berate（激しく叱る）と訳が重なり答えが一つに決まらない |
| eiken1 | reticent: 口数の少ない → 口が重い・控えめな — taciturn（無口な）と実質同じ訳 |
| eiken1 | laconic: 言葉少なで簡潔な → 簡潔で素っ気ない — succinct（簡潔な）と重なる |
| eiken1 | assuage: 和らげる → （不安・苦痛を）和らげる — ease / relieve / alleviate / mitigate など多数が同じ訳になる |
| eiken1 | eschew: 避ける → 意識的に避ける・控える — avoid が真っ先に浮かぶ一般訳 |
| eiken1 | clandestine: 秘密の → 秘密裏の・隠密の — secret が真っ先に浮かぶ一般訳 |
| eiken1 | squander: 浪費する → 浪費して使い果たす — waste が真っ先に浮かぶ一般訳 |
| eiken1 | exceedingly: 非常に → きわめて — very / extremely と区別できない |
| eiken1 | sedition: 扇動 → 反政府扇動・治安妨害 — 「扇動」だけだと incitement / agitation になる |
| toeic600 | benefit: 利益・福利厚生 → 恩恵・福利厚生 — 「利益」は同パックの profit の ja と重なる |
| toeic600 | feedback: 意見・反応 → フィードバック・感想 — 「意見」だけ見ると opinion を打ちやすい |
| toeic600 | presentation: 発表 → 発表・プレゼン — 「発表」だけでは announcement とも取れる |
| toeic600 | conference: 会議・大会 → 大会・協議会 — 「会議」は meeting を強く連想させる |
| toeic600 | storage: 保管・倉庫 → 保管 — 「倉庫」は warehouse の ja と重なる |
| toeic600 | leak: 漏れる・漏れ → 漏れる — pos が動なのに ja に名詞「漏れ」が入っている |
| toeic600 | decrease: 減る・減少 → 減る — pos が動なのに ja に名詞「減少」が入っている |
| toeic600 | assignment: 任務・課題 → 割り当てられた仕事・課題 — 「任務」は task / mission / duty など幅が広い |
| toeic730 | alternative: 代替の・代案 → 代替の — pos は「形」なのに ja に名詞の「代案」が混ざっている（名詞なら option/substitute を打つ学習者が出る） |
| toeic730 | plant: 工場 → 工場（製造プラント） — 「工場」だけなら大半の学習者は factory を打つ。factory は accept に入れたが、plant を狙うなら ja に補足が欲しい |
| toeic730 | component: 部品 → 部品（構成部品） — 「部品」だけなら part を打つのが自然。part は accept に入れた |
| toeic730 | numerous: 多数の → 多数の（numerous） — 「多数の」は many がまず出る。many は accept に入れたが出題意図とずれる可能性 |
| toeic730 | publicity: 宣伝・評判 → 宣伝・世間の注目 — 「評判」が入っていると reputation（別カード）と答えが重なる。reputation を accept に入れたが、ja を変えるなら外してよい |
| toeic730 | outstanding: 傑出した・未払いの → 未払いの・傑出した — 例文は「未払い」の意味なので、順序を入れ替えると例文と一致する |
| toeic730 | terminate: 終了させる → （契約などを）終了させる・打ち切る — 「終了させる」だけだと end/finish/close が同列に出る |
| toeic730 | decline: 減少する・断る → 減少する・断る（decline） — ja が二義なので decrease/refuse/reject の三つが同列になる。片方に絞るとよい |
| toeic730 | target: 対象・目標 → 目標（売上などの） — 「対象」だけ見ると object/subject を打つ学習者が出る。例文は「目標」の意味 |
| toeic860 | preliminary: 予備の → 予備的な・事前の — 「予備の」単独だと spare/backup(予備の鍵)を連想し、preliminary に辿り着きにくい |
| toeic860 | troubleshoot: 問題を解決する → (機器などの)不具合の原因を突き止めて解決する — 現状の訳では solve と区別がつかない(solve/fix を accept に入れた) |
| toeic860 | cease: 中止する → やめる・停止する — 「中止する」は cancel を強く想起させる(cancel を accept に入れたが、訳自体は stop/halt 寄りが望ましい) |
| toeic860 | recession: 景気後退 / downturn: 景気の下降 — 同パック内でほぼ同義の訳が2枚あり、互いに accept で相互参照させた。訳の差別化を検討 |
| toeic860 | considerable: かなりの / substantial: 相当な — 同パック内でほぼ同義の訳が2枚あり、互いに accept で相互参照させた |
| toeic860 | verify: 検証する → 確認する・検証する — 例文の訳は「ご確認ください」で confirm 寄り。訳と例文が合っていない |
| toeic860 | enforce: 施行する → (法律・規則を)施行する・執行する — 「施行する」単独だと implement/enact と区別しにくい |
| toeic860 | regardless: 〜にかかわらず(pos 副) — 訳は前置詞句 regardless of の形で、副詞単体の意味と見た目がずれる |
| toeic860 | payable: 支払うべき → 支払期限の来た・支払うべき — due との区別がつきにくい(due を accept に入れた) |
| toeic860 | keynote: 基調(講演) — 基調講演なら keynote speech/address。単語 keynote の訳として括弧付きで分かりにくい |
| toeic990 | whereby: それによって → 「(それ)によって〜する(ところの)」 — 関係副詞だが訳が thereby と完全に同じで区別できない（thereby は accept に入れた） |
| toeic990 | severance: 解雇・退職手当 → 「(雇用の)打ち切り・退職手当」 — 「解雇」だけなら dismissal / layoff が第一候補になり、severance は出てこない |
| toeic990 | turnaround: 所要時間・好転 → 「(作業の)所要時間・(業績の)好転」 — 「所要時間」だけでは time / duration を打つ学習者が多い |
| toeic990 | latency: 遅延 → 「(通信の)遅延・レイテンシ」 — 「遅延」単体では delay が第一候補（delay は accept に入れた） |
| toeic990 | invariably: 常に → 「決まって・例外なく」 — 「常に」は always と同一の訳で、他パックの always と衝突する |
| toeic990 | predominantly: 主に → 「主として・大部分は」 — mainly / mostly と同一訳で、他パックと衝突する |
| toeic990 | thereafter: その後 → 「それ以降(は)」 — 「その後」は afterwards / later / then と同一訳 |
| toeic990 | nominal: 名目上の・わずかな → 「名目上の・(料金が)わずかな」 — 「わずかな」側は slight / small など一般語と衝突しやすい |
| toeic990 | withhold: 差し控える → 「(支払いなどを)差し控える・保留する」 — 「差し控える」単体では refrain を打つ学習者が多い（refrain は accept に入れた） |
| toeic990 | proprietary: 専有の → 「専有の・独自の(自社所有の)」 — 「専有の」だけでは exclusive との区別がつきにくい（exclusive は accept に入れた） |
| highschool | protect: 守る → 保護する — 「守る」だけだと keep（約束を守る）／obey（規則を守る）も正解になりうる |
| highschool | allow: 許す → 許可する — 「許す」だけだと forgive（罪を許す）とも読める（forgive は accept に入れた） |
| highschool | notice: 気づく → （そのままでよいが）realize と区別がつかない — 同パック realize は「実感する」なので衝突はしないが、気づく=realize と打つ学習者が多い |
| highschool | determine: 決定する → 決意する／決定づける — 同パックの decision「決定」と並ぶと decide との区別がつかない（decide を accept に入れた） |
| highschool | indicate: 示す → 指し示す — 「示す」だけだと show が最有力で、indicate が第一想起にならない |
| highschool | human: 人間 → 人間（名詞） — person/man など複数の正解があり、形容詞 human（人間の）とも読める |
| highschool | technology: 技術 → 科学技術 — 「技術」だけだと technique／skill が同等に正解になる（両方 accept に入れた） |
| highschool | sport: スポーツ → （そのまま） — 学習者は sports と複数形で打つ可能性が高い（accept に sports を入れた） |
| highschool | finally: ついに → ついに／最後に — finally は「最後に」の意味でもよく出るが、訳が「ついに」だと at last／eventually 寄りに読める |
| highschool | actually: 実際は → 実は／実際に — 「実際は」は in fact／really にも対応し、actually が第一想起になりにくい |
| toeic | archive: 保管記録 → 記録保管所／保管文書 — 「保管記録」は日本語として不自然で、archive の意味（保存文書・保存庫）が伝わりにくい |
| toeic | admission: 入場料 → 入場（許可） — 入場料は admission fee。単語だけなら「入場・入場許可」。学習者は fee / entrance を打ちかねない |
| toeic | convention: 大会 → 大会（集会・会議） — 「大会」を見た学習者は tournament / competition を先に思いつく（accept には入れたが、訳の補足が望ましい） |
| toeic | deposit: 頭金 → 預金・保証金 — 学習者は deposit を「預金」で覚えているため、「頭金」からは down payment を連想しやすい |
| toeic | personnel: 人事 → 職員・人事部 — personnel は「職員（全体）」が本義で、「人事」だけだと HR / human resources と迷う |
| toeic | utility: 公共料金 → 公共サービス（電気・ガス・水道） — 公共料金は utility bill。単語の意味は「公共設備・サービス」 |
| toeic | amenity: 備え付け品 → 設備・快適さ — 「備え付け品」は hotel amenities の一用法のみで、amenity 本来の「生活を快適にする設備」が伝わらない |
| toeic | statement: 明細書 → 明細書（取引明細） — 「明細書」からは detail / breakdown も浮かび、statement の「声明」用法とも紛れる |
| toeic | reception: 歓迎会 → 歓迎会・受付 — TOEIC では「受付」の意味も頻出。歓迎会は welcome party とも言うため訳が一対一でない |
| toeic | benefit: 福利厚生 → 福利厚生（給付） — 福利厚生は通常 benefits（複数）。単数 benefit は「利益・恩恵」が先に浮かぶ |
| business | teamwork: 連携 → チームワーク — 連携 は cooperation / coordination / collaboration の方が先に浮かび teamwork に一意に決まらない（accept に cooperation, collaboration を入れた） |
| business | retire: 退職する → 定年退職する — 退職する は resign / quit / leave も正解になり一意でない（accept に resign, quit を入れた） |
| business | onboarding: 新人研修 → 入社手続き・受け入れ研修 — 新人研修 は training / orientation が自然で onboarding に結びつきにくい |
| business | internship: 実務研修 → インターンシップ — 実務研修 は practical training の意味が強く internship を想起しにくい |
| business | campaign: 販促活動 → キャンペーン — 販促活動 は promotion が第一候補で campaign に一意でない（accept に promotion を入れた） |
| business | branding: ブランド戦略 → ブランディング — ブランド戦略 は brand strategy で branding とは意味が少しずれる |
| business | portfolio: 事業構成 → 事業ポートフォリオ — 事業構成 から portfolio を想起するのは難しい |
| business | milestone: 中間目標 → マイルストーン・節目 — 中間目標 は interim goal で milestone に一意でない |
| business | corporation: 株式会社 → 法人・大企業 — 株式会社 は company / joint-stock company も正解で corporation に一意でない |
| business | stock: 株式 — 同パック内の shareholder（株主）・equity（自己資本）と近接し、share / shares も同じ訳で正解（accept に入れた） |
| it | terminal: 端末 → ターミナル — 端末 は日本語ではスマホなどの「機器」を指すのが普通で、device を打つ学習者が多い |
| it | runtime: 実行環境 → ランタイム — 実行環境 は environment を連想させる |
| it | query: 問い合わせ → クエリ — 問い合わせ は inquiry が第一想起（accept で救済したが訳自体を直したい） |
| it | patch: 修正プログラム → パッチ — 修正プログラム は fix / update も想起される |
| it | port: 接続口 → ポート — 接続口 は socket / connector / jack も正しい |
| it | login: ログインする → ログイン — en の login は名詞形で、動詞は log in（2 語）。訳の「〜する」とずれる |
| it | logout: ログアウトする → ログアウト — 同上 |
| it | gadget: 小型機器 → ガジェット — 小型機器 は device が第一想起 |
| it | chip: 半導体チップ → チップ — semiconductor を打つ学習者が出る |
| it | forum: 掲示板 → フォーラム — 掲示板 は bulletin board / board が第一想起 |

## 5. NGSL 24 パックの別解執筆時に挙がった候補（Batch 36、147 件・未反映）

基本語ほど多義で、同じパックに同じ訳の語が並ぶ（始める start／begin、置く put／set、〜の間に between／during など）。多くは互いに `accept` を入れてあるので打っても不正解にはならないが、訳を分けた方が親切なものは ○ を付けてもらえれば反映する。波ダッシュの字種（～ と 〜）の揺れの指摘も含む。

| パック | 候補 |
|---|---|
| ngsl01 | like: 好き → 好む・好きである — pos が「動」なのに訳が形容動詞で、学習者は fond / favorite など形容詞を連想しやすい |
| ngsl01 | well: 上手に・よく → 上手に・十分に — 「よく」は often（頻度）とも読めて答えが一つに決まらない |
| ngsl01 | that: あれ・それ → あれ・あの — 同パックの it（それ）と訳が重なる |
| ngsl01 | time: 時間 → 時間・時 — 「時間」だけだと hour を打つ学習者が多い（hour は accept に入れたが、訳側で区別した方がよい） |
| ngsl01 | very: とても → とても（程度を強める） — so（接: だから・それで）が同パックにあり、so を accept に入れたので訳の整理が望ましい |
| ngsl02 | between: ～の間に → ～の間に（2つの） — during と ja が完全に同じ（空間と時間で別の語） |
| ngsl02 | during: ～の間に → ～の間（期間中）に — between と ja が完全に同じ |
| ngsl02 | start: 始める → 始める（start） / begin: 始める — ja が完全に同じ 2 枚（accept を相互に入れた） |
| ngsl02 | home: 家・家庭 / house: 家 — 「家」で両方が正解になる（accept を相互に入れた） |
| ngsl02 | put: 置く / set: 置く・設定する — 「置く」で両方が正解になる（accept を相互に入れた） |
| ngsl02 | many: 多くの / much: 多くの・たくさんの — 「多くの」で両方が正解になる（accept を相互に入れた） |
| ngsl02 | little: 小さい・少しの / small: 小さい — 「小さい」で両方が正解になる（accept を相互に入れた） |
| ngsl02 | tell: 伝える・話す / talk: 話す・しゃべる — 「話す」で両方が正解になる（tell に talk/speak を入れた） |
| ngsl02 | kind: 親切な — 「種類」の意味が頻度上は主で、exJa は「優しい」。訳はこのままで問題ないが例文訳とのずれあり |
| ngsl02 | lot: たくさん（a ___ of） — 訳に空欄記法が入っている唯一のカード。形式が他と違う |
| ngsl03 | though: ～だけれども → 〜だけれども — although と同じ訳だが波ダッシュの字種が違う（～ U+FF5E vs 〜 U+301C）。until「～まで（ずっと）」も同じ字種ずれ。同一視すべき2枚なので統一を推奨 |
| ngsl03 | early: 早く・早い → 早く — pos が 副 なのに形容詞訳「早い」も併記されている |
| ngsl03 | hold: 持つ・開催する → 持っている・開催する — 「持つ」だけだと ngsl01 の have と訳が重なり答えが一つに決まらない（have を accept に入れた） |
| ngsl03 | quite / rather: かなり が両方に含まれ、互いに別解になる。rather は「むしろ」を主訳にしたほうが区別しやすい |
| ngsl03 | price: 値段 / cost: 費用 — 学習者は 値段→cost、費用→price も打つので相互に accept したが、訳側で「価格」「経費」など語を分けると区別しやすい |
| ngsl04 | power: 力・電力 → 同じ pack の force も ja が「力」。訳だけでは power / force が決まらない（相互に accept を入れて対応したが、force 側を「力ずく・武力」などにすると区別しやすい） |
| ngsl04 | sort: 種類 → 同じ pack の type が「種類・型」で重複。sort を「（口語の）種類」などにしないと sort / type / kind が区別できない（相互 accept で対応済み） |
| ngsl04 | bit: 少し → pos が名で「少し」は副詞的に読める。「少量・ちょっと」など名詞らしい訳にすると little との混乱が減る |
| ngsl04 | receive: 受け取る → get / accept も正解になるため訳だけでは決まらない（accept 済み）。「受信する・受領する」寄りにすると receive に絞れる |
| ngsl04 | watch: （じっと）見る → look / see / stare も「見る」で正解になる。「（テレビ・試合などを）見る」のほうが watch に絞れる |
| ngsl04 | create: 作り出す → make / produce も正解。「創造する」なら create に絞れる |
| ngsl04 | produce: 生産する → make / manufacture も正解（accept 済み） |
| ngsl04 | perhaps / probably: たぶん が両方に含まれ、確度の差が訳に出ていない。probably を「おそらく（高確率）」、perhaps を「ひょっとすると」に分けると区別できる |
| ngsl04 | human: 人間 → person も「人間」で正解になる。「人類・ヒト」なら human に絞れる |
| ngsl05 | accord: 一致・調和 → according to（〜によれば）or keep noun with a matching ex — ex/exForm use 'according' (preposition phrase), which does not illustrate the noun 一致・調和 |
| ngsl05 | staff: 職員 → スタッフ・職員 — ex translates staff as スタッフ; 職員 alone invites employee/official |
| ngsl05 | act: 行動する・行為 → 行動する — pos is 動 but ja also lists noun 行為 |
| ngsl05 | charge: 料金・請求する → 料金 — pos is 名 but ja also lists verb 請求する |
| ngsl05 | measure: 測る・対策 → 測る — pos is 動 but ja also lists noun 対策 |
| ngsl05 | vote: 投票・投票する → 投票 — pos is 名 but ja also lists verb 投票する |
| ngsl05 | outside: 外に・外側 → 外に — pos is 副 but ja also lists noun 外側 |
| ngsl05 | particular: 特定の・特別な overlaps with special (特別な) — a learner seeing 特別な cannot tell which card is meant; suggest 特定の for particular |
| ngsl05 | raise: 昇給 — noun-only sense; the far more common verb sense 上げる・育てる is absent, so learners may not connect it |
| ngsl05 | site: 場所・サイト — 場所 alone would elicit place; suggest 用地・サイト or 現場・サイト |
| ngsl06 | technology: 技術 → 科学技術・テクノロジー — 「技術」だけだと skill / technique が同等に正しく、答えが一つに決まらない（暫定で technique, skill を accept に入れた） |
| ngsl06 | fast: 速い・速く — pos が「形」なのに副詞義も併記されており、quickly など副詞も正解になる（quick, quickly, rapid を accept に入れた） |
| ngsl06 | inside: 〜の中に・内側 — 「〜の中に」は in がもっとも素直な答えで、inside に特定しづらい（in, within を accept に入れた） |
| ngsl06 | store: 商店 → 店 — 「商店」は shop の訳としても同等（shop を accept に入れた） |
| ngsl06 | heart: 心臓・心 — 「心」は mind とも訳せる（mind を accept に入れた） |
| ngsl07 | contract: 契約 ／ agreement: 合意・契約 — 同じパック内で「契約」が重なる。両方に互いを accept で入れたが、agreement の ja を「合意・協定」に寄せると区別しやすい |
| ngsl07 | sorry: ごめんなさい — 形容詞カードなのに訳が間投詞句。「すまなく思う・残念な」等の形容詞訳の方が pos と合う |
| ngsl07 | floor: 階 — floor の基本義「床」が訳に無く、story/storey と区別がつかない。「床・階」が妥当 |
| ngsl07 | stuff: 物・こと — thing と区別不能（thing が別パックにある場合は衝突）。「（漠然と）物・持ち物」などで区別可 |
| ngsl07 | challenge: 挑戦 — attempt（試み）と意味が近く、学習者は try/attempt も打ちうる。「難題・挑戦」とすると challenge らしさが出る |
| ngsl08 | target: 目標 → 的・目標 — 同パック内の goal (目標) と ja が完全に同じ。出題時に区別がつかない |
| ngsl08 | goal: 目標 → ゴール・目標 — 上と同じく target と ja が重複 |
| ngsl08 | bill: 会計 → 勘定書・請求書 — 「会計」だけだと accounting も正解になり、bill の意味からややずれる |
| ngsl08 | officer: 警察官・役人 → 警官・将校・役員 — officer 単独は「警察官」とは限らない（police officer で初めてその意味） |
| ngsl08 | message: 伝言 → メッセージ・伝言 — message の中心義より狭い訳で、他の語（note など）を連想させやすい |
| ngsl08 | access: 利用・接続 → 利用する権利・アクセス — 「利用」だけだと use と区別できない |
| ngsl08 | dress: ドレス・ワンピース — 訳としては問題ないが、ワンピースは和製英語なので one-piece と打つ学習者が出うる |
| ngsl09 | clock: 時計 → 置き時計・掛け時計 — watch も「時計」なので訳だけでは決まらない（watch は accept に入れた） |
| ngsl09 | exercise: 運動 → 運動（体を動かすこと） — movement／sport／workout も「運動」で答えが一つに決まらない |
| ngsl09 | credit: クレジット → 信用・クレジット — カタカナだけでは意味が取りにくい |
| ngsl09 | proposal: 提案書 → 提案・提案書 — proposal の基本義は「提案」で、「書」を付けると document 等に寄る |
| ngsl09 | property: 不動産 → 財産・不動産 — property の第一義は「財産・所有物」 |
| ngsl09 | exchange / replace: 交換する / 取り替える — 同パック内でほぼ同義の訳が並び、互いに別解になる（双方の accept に相手を入れた） |
| ngsl09 | track: 線路・走路 → 線路・走路・跡 — railway／rail も同じ訳で打たれる |
| ngsl10 | extra: 追加の → 「余分の・追加の」 — 同パック内の additional と ja が完全に同じ（2 枚重複） |
| ngsl10 | additional: 追加の → 「追加の・さらなる」 — 同上、extra と ja が同じ |
| ngsl10 | alternative: 代替の・代案 → 「代替の」 — pos は 形・tags は adj なのに訳に名詞「代案」が併記されている |
| ngsl10 | slow: 遅い → 「（速度が）遅い」 — 「遅い」だけでは late（時刻が遅い）と区別できない |
| ngsl10 | reply: 返信する → 「返事する・返信する」 — respond（返答する）とほぼ同義で、学習者はどちらも互いに打ちうる |
| ngsl10 | glass: ガラス・コップ → 「ガラス・グラス」 — 「コップ」は cup とも取れる |
| ngsl10 | status: 状況・地位 → 「状態・地位」 — 「状況」は situation に寄りすぎる |
| ngsl10 | trial: 試し・裁判 → 「試用・裁判」 — 「試し」は test/try とも取れる |
| ngsl11 | photograph: 写真 → 「写真（正式語）」または「写真・フォトグラフ」 — 同パック内の photo と ja が同一。訳だけでは photo / photograph / picture のどれを打つべきか決まらない |
| ngsl11 | photo: 写真 → 「写真（口語）」 — 同パック内の photograph と ja が同一（上と対） |
| ngsl11 | labor: 労働 → 「労働・労力」 — 米式つづり固有の情報が訳に無く、学習者は labour / work も打ちうる（accept で対応済み） |
| ngsl11 | feed: 食べ物を与える → 「えさをやる・食べ物を与える」 — exJa は「えさをやる」。訳が長く、品詞感が伝わりにくい |
| ngsl11 | mass: 大量の・大衆の → 「大量の・大規模な」 — 「大衆の」は mass media 等の連語でのみ成り立つ。単独の形容詞訳としては誤解を招く |
| ngsl11 | left: 左の・左へ → 「左の」 — pos が形なのに「左へ」（副詞）を併記。ta­gs も adj。どちらかに揃えたい |
| ngsl11 | plus: 〜を足して・プラス → 「〜を足して（前置詞）」 — 「プラス」だけ見ると名詞や間投詞と受け取られる |
| ngsl11 | traffic: 交通（量） → 「交通量・交通」 — 括弧付き表記が他カードと不揃い。transport（輸送・交通機関）との区別は訳からは付きにくい |
| ngsl11 | struggle: 苦労する・もがく → 「苦労する・奮闘する」 — 「もがく」は身体的な動きが主で、exJa（苦労した）とずれる |
| ngsl11 | adopt: 採用する → 「採用する（方法・案を）・導入する」 — 「採用する」は人を雇う意味（hire）に取られやすい。exJa は「導入している」（accept に hire / employ を入れたが、訳を絞る方がよい） |
| ngsl12 | jump: とぶ → 跳ぶ・ジャンプする — ひらがな「とぶ」は飛ぶ（fly）とも読める。今回は fly も accept に入れたが、ja を漢字にすれば不要 |
| ngsl12 | code: コード・暗号 → 暗号・（プログラムの）コード — カタカナ「コード」は cord（電気コード）・chord（和音）とも取れる。暗号の併記で絞れてはいるが、出題意図（例文は暗証コード）に寄せた訳のほうが安全 |
| ngsl12 | twice: 2回 → 2回・2倍 — 答えは twice 一つだが、「2回」だけ見た学習者は two times と考えて止まりやすい。訳に「（副詞）」等の補足があるとよい |
| ngsl12 | host: （客を招く）主人・主催者 — 「主人」は husband／master とも読め、括弧書きがないと迷う。現状の括弧書きで絞れているので置換案なし（注意喚起のみ） |
| ngsl12 | tire: 疲れさせる・疲れる — 同綴りの名詞 tire（タイヤ）が別パックにあると ja で区別できるが、「疲れる」単独だと get tired の句を打とうとする学習者が多い。訳は妥当だが、exJa「本当に疲れる」が自動詞寄りで en の他動詞用法と少しずれる |
| ngsl13 | army: 軍隊・陸軍 → 陸軍 — 同パック troop の ja も「軍隊・部隊」で「軍隊」が重複。army は陸軍に絞ると一意になる |
| ngsl13 | troop: 軍隊・部隊 → 部隊・兵士たち — army と「軍隊」が重複。troop は通常 troops（部隊・兵士）の意 |
| ngsl13 | gold: 金 → 金（きん）・黄金 — 「金」だけでは「かね＝money」とも読め、money を打つ学習者が出る |
| ngsl13 | cup: コップ → カップ・コップ — 日本語の「コップ」はガラスの glass を指すことが多く、cup とずれる（glass/mug を accept に入れた） |
| ngsl13 | civil: 市民の・民間の → 市民の・民事の — 「民間の」は private の訳として定着しており civil とずれる |
| ngsl13 | capacity: 生産能力・収容力 → 収容力・能力 — 「生産能力」は狭すぎ、production capacity の文脈に限られる |
| ngsl13 | technical: 技術的な・専門の → 技術的な — 「専門の」は professional/specialized を誘い、technical の中心義からずれる |
| ngsl14 | commitment: 献身・約束 → 献身・責任ある約束 — 「約束」だけ見ると promise を打つ学習者が多い（accept に入れたが、訳の軸が commitment 寄りだと伝わりにくい） |
| ngsl14 | row: 列 → 横一列・（座席の）列 — 「列」だけだと line / queue / column も同等に正しい |
| ngsl14 | cast: 出演者・配役 → 出演者全員・配役 — 「出演者」は単数だと actor / performer が第一候補 |
| ngsl14 | commission: 手数料 → （仲介）手数料 — 「手数料」単独だと fee / charge が第一候補 |
| ngsl14 | device: 機器・装置 → （小型の）機器・装置 — 「機器」は equipment、「装置」は apparatus を打つ学習者も多い |
| ngsl14 | forest: 森 → 森林 — 「森」だと wood / woods も同等 |
| ngsl14 | grade: 成績・学年 → 成績（評点）・学年 — 「成績」だけだと score / mark が先に浮かぶ |
| ngsl14 | appearance: 外見・出現 → 外見・見た目 — 「外見」は look(s) も同等、「出現」は emergence 寄り |
| ngsl15 | sick: 病気の → 「病気の（口語）」など — 同じパック内で ill（病気の）と ja が同一。互いに accept には入れたが、訳だけでは一つに決まらない |
| ngsl15 | latter: 後者の・後者 → 「後者の」 — pos が 形 なのに名詞の訳も併記されている |
| ngsl15 | musical: 音楽の → 「音楽の・音楽好きな」 — 例文訳は「音楽好きな」で ja と一致していない |
| ngsl16 | seed: 種 → 種（たね） — 「種」だけだと「しゅ・種類」(kind/species) とも読める |
| ngsl16 | self: 自分自身 → 自己・自我 — 「自分自身」だと myself / oneself と打つ学習者が多そう（代名詞なので accept には入れていない） |
| ngsl16 | diet: 食事・ダイエット → 日常の食事・ダイエット — 「食事」だけだと meal と打つ可能性が高い（meal は accept に入れた） |
| ngsl16 | dozen: 12個・ダース → 1ダース（12個） — 数語扱いで accept は入れていないが、「12個」だけだと twelve と打つ可能性あり |
| ngsl17 | reporter: 記者 / journalist: ジャーナリスト・記者 → both cards share 記者 in the same pack; cross-accepted, but consider 「（新聞・テレビの）記者」 for reporter |
| ngsl17 | convention: 大会 → 「（業界の）大会・会議・慣習」 — 大会 alone invites tournament/competition, which is not this sense |
| ngsl17 | corporation: 株式会社 → 「法人・大企業」 — corporation is not specifically 株式会社 (that is a joint-stock company) |
| ngsl17 | dish: 料理 → 「料理・皿」 — the primary sense 皿 is missing; a learner thinking 料理 may type food/cuisine (accepted) |
| ngsl17 | excuse: 許す → 「（軽い失礼を）許す・言い訳」 — 許す alone points to forgive/allow (forgive, pardon accepted) |
| ngsl17 | retain: 保持する (level easy) → 「保持する・保管する」 — the example uses 保管 sense; also the easy level looks off for this word |
| ngsl18 | gate: 搭乗口 → 門・搭乗口 — gate の基本義は「門」。搭乗口だけだと学習者が gate にたどり着きにくい |
| ngsl18 | pitch: 売り込み → 売り込み（sales pitch） — 単独の pitch は「投球・音の高さ」が先に浮かび、訳から一意に決まりにくい |
| ngsl18 | fault: せい・過失 → 責任・過失 — 「せい」は blame/responsibility も連想される |
| ngsl18 | input: 意見・入力 → （求められた）意見・入力 — 「意見」だけなら opinion/feedback が第一候補になる |
| ngsl19 | alter: 変える → 変更する・改める — 同パック内の transform(変える)と ja が完全に同じ。両者に相互 accept を付けたが、ja を分けたほうがよい |
| ngsl19 | transform: 変える → 一変させる・変形させる — alter と ja が同じ（上記）。例文訳も「一変させた」なので寄せる案 |
| ngsl19 | platform: 乗り場 → （駅の）ホーム・乗り場 — 「乗り場」だけだと stop / stand（バス・タクシー乗り場）も正解になりうる。プラットホームと分かる訳が望ましい |
| ngsl19 | pupil: 生徒・瞳 → 生徒・児童 — 「生徒」の訳では student を打つ学習者が大半で、pupil が出てきにくい。「児童」を併記すると pupil に寄る |
| ngsl19 | anymore: もう（〜ない） → （否定文で）もはや — no longer と同義で、1 語の別解が立てられない訳。現状でも可だが注記 |
| ngsl19 | false: 誤った・偽の → 偽の・間違った — 「誤った」単独だと wrong / incorrect / mistaken の方が自然で、false はやや二義的（真偽の「偽」） |
| ngsl20 | knee: 膝 → 膝（ひざ関節） — 膝は lap（膝の上）とも訳せるので lap を accept に入れた。訳を絞るなら「膝（関節）」 |
| ngsl20 | vice: 副〜（___ president など） → そのまま — vice は接頭辞的用法で pos 形は便宜上。別解なし |
| ngsl20 | mate: 仲間 → 仲間・相棒 — 仲間だけだと companion/fellow/colleague など候補が広い（companion/buddy/fellow を入れた） |
| ngsl20 | deposit: 保証金・預金 → 保証金・頭金・預金 — 「預金」だけなら savings が最初に浮かぶ（savings を入れた） |
| ngsl21 | cap: ぼうし → （つばの付いた）ぼうし・キャップ — 「ぼうし」だけでは hat が第一候補になる（hat を accept に入れた） |
| ngsl21 | greatly: 大いに・非常に → 大いに・大幅に — 「非常に」は very を強く連想させる（very / extremely を accept に入れたが、ja を直すなら外してよい） |
| ngsl21 | successfully: うまく・首尾よく → 首尾よく・無事に — 「うまく」は well を連想させるが well は accept にできない |
| ngsl21 | eastern: 東の・東部の → 東部の・東側の — 「東の」は east でも正しい（east を accept に入れた） |
| ngsl22 | whilst: 〜する間・一方で（=while） → 〜する間・一方で — ja に別解 while が書かれており、accept の while と重なる（ヒントとして残すなら要判断） |
| ngsl22 | sake: 〜のため（for the ___ of） → 〜のため（for the ___ of） — 訳が熟語の穴埋め形式で他カードと体裁が異なる（問題はないが要確認） |
| ngsl22 | personnel: 人事 → 職員・人員（人事部） — personnel の中心義は「職員・人員」で、「人事」単独だと human resources を連想させる |
| ngsl22 | gallery: 美術館 → 画廊・美術館 — gallery の中心義は画廊で、「美術館」だけだと museum と区別がつかない（museum を accept に入れた） |
| ngsl22 | march: 3月・行進 → 3月・行進 — 3月の意味では大文字 March なので、小文字出題との整合を確認 |
| ngsl23 | magic: 魔法・手品 → 魔法 — 同パックの trick (手品・いたずら) と「手品」が重なるので相互に accept を入れたが、ja を分けた方が明快 |
| ngsl23 | trick: 手品・いたずら → いたずら・策略 — magic と「手品」が重なる（上記と同じ理由） |
| ngsl23 | ocean: 海・大洋 → 大洋・大海 — 「海」だけ見ると sea が第一候補になる（sea を accept に入れた） |
| ngsl23 | distinct: はっきり異なる・明確な → はっきり異なる・独特の — 「明確な」は clear/obvious が先に浮かび、distinct の中心義からやや外れる |
| ngsl23 | compose: 作曲する・構成する → 作曲する・（詩文を）書く — 「構成する」は constitute/make up が先に浮かぶ |
| ngsl23 | regardless: 〜にかかわらず → （〜に）かかわらず・それでも — 訳が前置詞句 regardless of 前提で、単独副詞の用法が見えにくい |
| ngsl24 | rice: ご飯 → 米・ご飯 — 「ご飯」は食事（meal）とも取れる |
| ngsl24 | uncertainty: 不確かさ・不安 → 不確実さ・不確かさ — 「不安」だと anxiety/worry を強く連想する |
| ngsl24 | immigration: 移民・入国審査 → 移住・入国審査 — 「移民」は人（immigrant）と読める |
| ngsl24 | found: 設立する — 訳は問題ないが find の過去形と同形で、出題時に混乱しやすい（参考） |
