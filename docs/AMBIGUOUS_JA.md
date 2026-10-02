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
