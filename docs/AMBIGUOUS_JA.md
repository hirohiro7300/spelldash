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

## 6. TSL／BSL／NAWL 34 パックの別解執筆時に挙がった候補（Batch 37、211 件・未反映）

英語の見出し語が単数形で不自然なもの（headquarter → headquarters、pant → pants、congratulation → congratulations）、同じパック内で訳が近い組（goods／merchandise、trainee／intern）、品詞と訳のずれ（pos が 動 なのに名詞の訳が併記）など。見出し語そのものを直す提案は ⚠ として扱い、判断してもらってから反映する。

| パック | 候補 |
|---|---|
| bsl01 | portfolio: 事業構成 → ポートフォリオ・事業構成 — 事業構成 だけでは portfolio を想起しにくい（lineup／structure を打ちそう） |
| bsl01 | client: 取引先 → 顧客・取引先 — 取引先 は business partner／supplier も指し、client の中心義「顧客」が伝わらない |
| bsl01 | utility: 公共料金 → 公共サービス・公共料金 — 公共料金 は通常 utility bill／utilities（複数）で、単数 utility は「公益事業」 |
| bsl01 | volatility: 変動の大きさ → 変動性（ボラティリティ） — 説明文的で、学習者が fluctuation を打ちそう |
| bsl01 | beta: ベータ版（試験版） → ベータ（ベータ値・ベータ版） — BSL（金融）の beta は株式のベータ値が中心。IT の訳になっている |
| bsl01 | media: メディア・報道 → メディア・報道機関 — 報道 単独だと report／coverage／news が答えになりうる |
| bsl01 | stockmarket: 株式市場 — ja ではなく en が BSL 独自の一語つづり。学習者は stock market（2 語）を打つので正解にできない |
| bsl02 | withdrawal: 引き出し・撤退 → （預金の）引き出し・撤退 — 「引き出し」だけだと家具の drawer と取れる |
| bsl02 | parameter: 条件・範囲 → パラメータ・媒介変数（条件・範囲） — 一般的な訳はパラメータ。「条件・範囲」だけでは condition/range/scope と区別できない |
| bsl02 | exploit: 搾取する・利用する → 搾取する・（資源などを）活用する — 「利用する」が広すぎて use と区別できない |
| bsl02 | governance: 統治・企業統治 → 企業統治・ガバナンス — 「統治」だけだと rule/government と重なる |
| bsl02 | bound: （契約に）拘束された → 拘束された（be bound by） — 形容詞 bound は過去分詞としての用法で、カードとしてはやや特殊 |
| bsl02 | sophisticate: 洗練させる → （動詞）洗練させる — 動詞用法は稀で、学習者は sophisticated（形）を連想しやすい |
| bsl02 | lobby: ロビー → ロビー（玄関ホール） — 「圧力団体」の lobby との区別のため補足があると親切 |
| bsl03 | headquarter: 本社 → headquarters を見出し語にするか ja を「本社を置く」(動詞) に — headquarter 単独は名詞として不自然。accept に headquarters / hq を入れた |
| bsl03 | immigration: 入国審査 → 移民・入国管理 — immigration の中心義は移民・入国管理。入国審査は immigration control / passport control の略用法 |
| bsl03 | deputy: 副～・代理 → 副官・代理人 — 「副～」は接頭的で名詞の訳として答えが絞れない(vice / proxy / substitute も浮かぶ) |
| bsl03 | bust: 倒産する → 破綻する・破産させる — bust 単独動詞は「破裂させる・摘発する」が主で、倒産は go bust の句 |
| bsl03 | tech: 技術・IT業界 → テック・技術(technology の略) — 「技術」だけ見ると technology / technique / skill が浮かぶ |
| bsl03 | con: 欠点・反対意見 → 反対意見(pros and cons の con) — 「欠点」だと drawback / flaw / weakness が先に出る |
| bsl03 | charter: 憲章・貸し切り → 憲章・特許状 — 「貸し切り」は chartered の用法で、名詞 charter 単独では伝わりにくい |
| bsl04 | automobile: 自動車 → (same ja as auto) — two cards in this pack share ja 自動車; consider 自動車（正式語） or merge |
| bsl04 | auto: 自動車 → 自動車（略） — duplicate ja with automobile |
| bsl04 | gamble: 賭け・賭ける → 賭け — ja mixes noun and verb while pos is 名 |
| bsl04 | capitalization: 時価総額 → 資本化・時価総額 — alone, capitalization means 資本化 (or 大文字化); 時価総額 is market capitalization |
| bsl04 | endorse: 推奨する → 支持する・承認する — core business senses are endorse a candidate/plan (支持・承認) or endorse a cheque (裏書き); 推奨する invites recommend |
| bsl04 | quota: ノルマ → 割り当て・ノルマ — quota is primarily an allotted share; ノルマ covers only the sales-target sense |
| bsl04 | precede: 先に起こる → 先行する・先立つ — 先に起こる reads like an event-only paraphrase |
| bsl05 | inter: 〜の間の・相互の（接頭辞） → 要検討 — 単語として inter は「埋葬する」（動詞）。接頭辞を形容詞カードとして出題しているので、訳だけでは何を打つか決まりにくい |
| bsl05 | capitalist: 資本主義の → 資本家・資本主義者（名）または「資本主義の」のまま — capitalist は名詞が主で形容詞用法は限定的。ja が「資本主義の」だと capitalistic も同じく正解になる |
| bsl05 | render: （サービスを）提供する → 置換案なし — この訳では provide / offer / supply が先に出るので、render を思い出すヒントが弱い |
| bsl05 | deploy: 配置する・投入する → 配備する・展開する — 「配置する」だけでは arrange / place / station が先に出る |
| bsl06 | bail: 救済する → 救済する（bail out）・保釈金 — bail 単独では「保釈（金）」が第一義で、「救済する」は bail out の句動詞の意味。訳だけ見ると rescue／save と区別がつかない |
| bsl06 | span: 〜にわたる → （期間・範囲に）わたる — 訳が助詞付きの句の形で、動詞 1 語の答えを導きにくい |
| bsl06 | discharge: （義務を）果たす → （義務を）果たす・解雇する — 同パック termination の訳に「解雇」があり、discharge 自体も「解雇する／放出する」が主要義。現状の訳は限定的で fulfill と区別がつきにくい |
| bsl06 | handful: ひと握り・少数 → ひと握り（の人・物） — 「少数」だけ見ると few／minority を打つ学習者がいるが名詞 1 語では受けにくい |
| bsl07 | preliminary: 予備の → 予備的な・準備段階の — 「予備の」は spare／reserve（予備のタイヤ）と読まれやすく、preliminary の「本番前の・事前の」が伝わらない |
| bsl07 | semi: 半〜・準〜 → 半分の・準〜 — 接頭辞の訳で 1 語の英単語に対応しづらい（学習者は half を打ちやすい。accept に half, quasi を入れた） |
| bsl07 | tuple: タプル・組 → タプル（組み） — 「組」だけだと set／pair／group と読める |
| bsl07 | validity: 有効性 → 妥当性・有効性 — ビジネス文脈の「有効性」は effectiveness と打たれやすい（accept に effectiveness を入れた） |
| bsl07 | orientation: 新人研修 → 新人研修・オリエンテーション — 訳が狭く、training と打たれると不正解になる |
| bsl08 | basket: かご → 買い物かご — ひらがなの「かご」は籠（cage）とも取れる |
| bsl08 | disability: 障害 → 身体の障害 — 「障害」は obstacle／failure／disorder の訳でもある |
| bsl08 | recruitment: 採用 → 人材の採用 — 「採用」は adoption（案の採用）の訳でもある |
| bsl08 | receiver: 受取人・受話器 / handset: 受話器・携帯端末 → 同じパック内で「受話器」が両カードに重なる。receiver は「受取人・受信機」、handset は「携帯端末・受話器」に分けると衝突しにくい |
| bsl08 | alert: 警告する・知らせる / notify: 通知する → 「知らせる」と「通知する」が近く、どちらを打つか迷う。alert は「警告する」だけでもよい |
| bsl08 | purely: 純粋に・全く → 純粋に・ただ〜だけ — 「全く」は completely／entirely と重なりやすい |
| bsl09 | forum: 掲示板 → フォーラム・掲示板 — forum は本来「討論の場・会議」。IT のユーザーフォーラムの意味だけに絞った訳で、学習者が forum を思いつきにくい |
| bsl09 | admission: 入場料 → 入場・入場料 — admission の中心義は「入場（許可）」。「入場料」単独だと fee／charge を打ちたくなる |
| bsl09 | compile: コンパイルする → 編集する・まとめる（コンパイルする） — BSL（ビジネス）のパックなのに IT のカタカナ語だけの訳。本来の「資料をまとめる」の意味が落ちている |
| bsl09 | accountable: 説明責任のある → 責任を負う・説明責任のある — 例文訳も「責任を負う」としており、responsible を打つ学習者が出やすい |
| bsl09 | determinant: 決定要因 → 決定要因（1 語で） — 「決定要因」は determining factor とも訳せ、factor を打つ学習者が出やすい |
| bsl10 | spark: 引き起こす → 火付け役となる・引き起こす — cause/trigger/provoke など多数の語が同じ訳になり、spark 固有の意味が見えない |
| bsl10 | arguably: おそらく・ほぼ間違いなく → 議論の余地はあるが・おそらく — 「ほぼ間違いなく」は arguably より強い確度で、probably/certainly 側に寄る |
| bsl10 | renewal: 更新 → （契約などの）更新 — 「更新」だけだと update と区別がつかない |
| bsl10 | dot: 点・ドット → 点（ドット） — 「点」は point/spot にも当たるため |
| bsl10 | constituency: 選挙区 → 選挙区（有権者） — 単語 1 語で別の訳語が立たず、district と迷う学習者が出そう |
| bsl11 | predictor: 予測の手がかり → 予測因子・予測指標 — 現訳は説明的で、学習者が一語を思い出しにくい |
| bsl11 | erode: 徐々に減らす → 侵食する・徐々に損なう — erode は自動詞「徐々に減る」でも頻用。「減らす」だけだと reduce 系を打たれやすい |
| bsl12 | overtime: 残業 → 時間外に・残業で — pos が 副（tags adj）なのに訳が名詞。名詞なら pos を 名 に、副詞のままなら訳を副詞句に |
| bsl12 | cattle: 牛（家畜の総称） → 牛（家畜・集合的に） — 学習者は cow を打つ可能性が高い（accept に cow/ox を入れたが、訳側で cattle を導きたいなら「畜牛」などの検討を） |
| bsl12 | ideology: イデオロギー・思想 → イデオロギー（政治・社会の思想体系） — 「思想」だけだと thought/idea など広く取れる |
| bsl12 | graphics: 図や画像 → グラフィックス（図版・画像） — 「図や画像」は picture/figure/image も正解になり得る |
| bsl12 | grasp: （内容の）把握 → （内容の）把握・理解 — understanding/comprehension を打つ学習者が多そう（accept に入れた） |
| bsl12 | cleaner: 清掃員 → 清掃員（人） — cleaner は「洗剤」の意味もあるが訳は人なので janitor/custodian が同等。問題なければ現状可 |
| bsl12 | underwriter: 引受会社・保険引受人 → （証券の）引受会社・保険引受人 — 「引受会社」だけだと insurer と区別しにくい（accept に insurer を入れた） |
| bsl13 | bounce: 直帰（1ページだけ見て離脱） → 跳ね返る・直帰する — pos が 動 なのに訳が名詞形。Web 解析の専門義のみで一般義（跳ねる）が無い |
| bsl13 | unauthorize: 許可を取り消す → （語自体が稀。unauthorized の形容詞で収録し直す案） — unauthorize は辞書にほぼ無い動詞で、学習者が答えにたどり着けない |
| bsl13 | amongst: 〜の間で（among の別形） — 訳に答えのヒント語 among が書かれているので among を accept に入れたが、ヒント表記を外すか判断が要る |
| bsl13 | reap: 得る・収穫する — 「得る」だけだと get/gain/obtain 等が無限に正解になる。「（利益を）刈り取る・収穫する」に寄せる案 |
| bsl13 | mentor: 指導者 → 助言者・メンター — 「指導者」は leader/instructor が第一想起で mentor が出にくい |
| bsl13 | faculty: 教授陣・学部 — 「学部」は department が第一想起。訳を「教授陣」に絞る案 |
| bsl13 | specialty: 名物・専門 — 「専門」だけ見ると major/field が想起される。「専門分野・名物料理」に寄せる案 |
| bsl13 | drain: 流出・消耗 — pos 名 だが drain は動詞義が主で、「流出」は outflow/leak が想起される |
| bsl13 | manipulation: 操作・不正操作 — 「操作」は operation が第一想起。「（不正な）操作・改ざん」に寄せる案 |
| bsl13 | endorsement: 支持・推薦 — 「支持」は support が第一想起で endorsement が出にくい。「（公の）支持表明・推薦」に寄せる案 |
| bsl14 | expectancy: 見込み（life ___ で平均寿命） → 期待・見込み — ヒント付きの訳で、単独では expectation などとも取れる |
| bsl14 | scratch: ゼロから（from ___） → 引っかき傷・ゼロから（from scratch） — 名詞 pos なのに訳が句の一部になっている |
| bsl14 | annum: 年（per ___ で1年あたり） → 年（ラテン語、per annum） — 「年」だけなら year を打つ学習者が多い |
| bsl14 | proprietorship: 個人事業（sole ___） → 所有権・個人事業（sole proprietorship） — 単独では business などとも取れる |
| bsl14 | franc: スイスなどの通貨単位 → フラン（スイスなどの通貨単位） — 語そのものの訳が無く、説明だけでは答えが決まらない |
| bsl14 | ounce: 重さの単位（約28グラム） → オンス（約28グラム） — 同上。説明だけでは gram などとも取れる |
| bsl14 | neo: 新〜・新しい形の（接頭辞） → ネオ・新〜（接頭辞） — 単独語として出題する妥当性が低く、new と打たれやすい |
| bsl14 | electorate: 有権者（全体） → 有権者全体・選挙民 — 単独では voter を打つ学習者が多い |
| bsl14 | intrigue: 興味をそそる → 興味をそそる・陰謀 — 他パックで名詞「陰謀」として出る可能性があり、本パックは動詞限定であることを明記した方がよい |
| bsl15 | mold: 型・鋳型 → 鋳型・かび（mold は「かび」も） — 「型」だけ見ると type / pattern / model / form を打ちやすい |
| bsl15 | seeker: 求める人・求職者 → 探し求める人（job ___ で求職者） — 「求職者」だけでは applicant / job-seeker（2語）に流れる |
| bsl15 | monopolist: 独占企業・独占者 → 独占者・独占企業家 — 「独占企業」は monopoly とも訳せる |
| bsl15 | worksheet: 作業用の表・練習用紙 → ワークシート・練習用紙 — 「作業用の表」は spreadsheet / table と取られうる |
| bsl15 | confirmation: 確認・確認書 → 確認（書）・確定 — 「確認」単独は check / verification が先に浮かぶ（verification は accept に入れた） |
| bsl15 | demise: 消滅・終焉 → 終焉・（制度などの）消滅・死去 — 「消滅」は disappearance / extinction / collapse に広がる |
| bsl15 | cruise: 船旅 → クルーズ・遊覧航海 — 「船旅」は voyage が同程度に自然（accept に入れた） |
| nawl01 | admission: 入場料 → 入場・入学（許可） — NAWL の学術文脈では「入学・入場・容認」の意味。入場料なら admission fee / entrance fee と迷う |
| nawl01 | availability: 空き状況・在庫 → 利用可能性・入手しやすさ — 学術の availability は「利用できること」。在庫だと stock と迷う（stock/inventory を accept に入れた） |
| nawl01 | carrier: 運送会社 → 保菌者・担体・運送業者 — 学術では「保菌者・キャリア」の意味が多い |
| nawl01 | binary: 二進数 → 二進法の・二元の — NAWL では形容詞用法が主。二進数なら binary number |
| nawl01 | assembly: 組み立て → 組み立て・集会・議会 — 学術では「集会・議会」の意味が多い |
| nawl01 | bound: （契約に）拘束された → 〜する義務がある・向かう・境界 — 用法が広く、この訳だけでは bound を思いつきにくい |
| nawl01 | bargain: お買い得品 → 取引・交渉 — 学術・ビジネスでは「取引・交渉（する）」の意味が中心 |
| nawl02 | client: 取引先 → 顧客・依頼人 — client は個人の依頼人・顧客が中心。「取引先」だと customer/partner/account を打つ学習者が出る |
| nawl02 | compact: 小型の → 小型で場所を取らない — 「小型の」だけだと small/mini が自然な別解になり、compact 固有の意味が見えない |
| nawl02 | convergence: 収束・集中 → 収束・（一点への）集中 — 「集中」だけだと concentration/focus を思い浮かべやすい |
| nawl03 | discrete: 別個の → 離散的な・別個の — NAWL の学術的な意味（離散変数）が訳に出ていない。現状の訳だと separate / distinct が正解になる |
| nawl03 | disability: 障害 → （心身の）障害 — 「障害」だけだと obstacle / barrier / disorder / failure も思い浮かぶ |
| nawl03 | fever: 熱 → 発熱・（病気の）熱 — 「熱」だけだと heat / temperature も正解になる |
| nawl03 | erase: 消す → 消去する・消し去る — 「消す」は turn off（電気）/ put out（火）にも読める |
| nawl03 | dissection: 解剖 → 解剖（切り開くこと） — 「解剖」だけだと anatomy / autopsy も同じ訳 |
| nawl03 | descendent: 子孫 — 訳は妥当だが見出し語 descendent は異綴りで、標準は descendant（accept に入れてある） |
| nawl03 | ex: 元〜・前の — ex は接頭辞で単独の形容詞としては弱い。former / previous を打つ学習者が多そう |
| nawl04 | headquarter: 本社 → （en を headquarters に）— 名詞としての標準形は headquarters。headquarter は動詞（本社を置く）の逆成語で、学習者は headquarters と打つ（accept に headquarters を入れて暫定対応） |
| nawl04 | hip: 腰・股関節 → 尻・腰骨・股関節 — 「腰」は英語では waist／lower back で、hip は腰骨の張り出した部分。waist と打たれても正解にできない |
| nawl04 | hierarchy: 階層 → 階層構造・序列 — 「階層」だけだと layer／level／stratum とも取れる |
| nawl04 | gross: 総額の・税引き前の → 総計の（控除前の） — 「総額の」は total と区別がつきにくい（accept に total を入れた） |
| nawl04 | incumbent: 現職の → 現職の・在任中の — 「現職の」だけだと current／present とも取れる（accept に current を入れた） |
| nawl04 | junior: 後輩の・下級の → 下位の・年少の — 「後輩の」は英語で一語に対応しにくく、younger／lower とも取れる |
| nawl04 | lateral: 横の・側面の → 側面の・横方向の — 「横の」は side／horizontal とも取れる（accept に side を入れた） |
| nawl05 | mentor: 指導者 → 助言者・指導役 — 「指導者」は leader／instructor／coach が第一想起で mentor（助言役の先輩）に特有の意味が出ない。leader・instructor・coach を accept に入れたが訳の方を絞る余地あり |
| nawl05 | manual: 取扱説明書 → 説明書・マニュアル — NAWL では「手引き・マニュアル」の広い意味。handbook を accept に入れたが訳はやや狭い |
| nawl05 | momentum: 勢い → 運動量・勢い — 学術（物理）の意味 momentum（運動量）が訳から出ない。「勢い」だけだと impetus／force と区別がつかない |
| nawl05 | media: メディア・報道 → 媒体・メディア — NAWL の media は medium の複数（培地・媒体）の意味も多い。「報道」だけだと press・news と重なる |
| nawl05 | matrix: 行列・マトリックス — 「行列」は queue／line（人の列）の意味もあるが、マトリックス併記で判別可。念のため報告 |
| nawl06 | optimal: 最適な → same ja as optimum (line 25) — two cards in this pack share the ja; each accepts the other |
| nawl06 | optimum: 最適な → same ja as optimal (line 24) — duplicate ja within pack |
| nawl06 | precipitation: 降水量 → same ja as rainfall (line 135) — duplicate ja within pack; each accepts the other |
| nawl06 | rainfall: 降水量 → same ja as precipitation (line 90) — duplicate ja within pack |
| nawl06 | prediction: 予測 → same ja as projection (line 109) — duplicate ja within pack; each accepts the other |
| nawl06 | projection: 予測 → 「（将来の）予測・見通し」 — same ja as prediction (line 92) |
| nawl06 | pre: 前の・事前の → 「前の（接頭辞）」 — pre is a prefix, not a standalone word; ja invites prior/previous/former, which were accepted |
| nawl06 | preliminary: 予備の → 「予備的な・準備段階の」 — 予備の is commonly read as spare/backup, which is a different sense from preliminary |
| nawl06 | parameter: 条件・範囲 → 「（変動する）条件・媒介変数」 — condition and range are generic and match many other words; accepted both but the ja barely points to parameter |
| nawl06 | powder: 粉 → 「粉末」 — 粉 alone suggests flour for many learners |
| nawl07 | replicate: 複製する・再現する → （reproduce と同一の ja）— 同パック内の reproduce と訳が完全に同じで、訳だけでは区別できない |
| nawl07 | reproduce: 複製する・再現する → 生殖する・複製する — replicate と同一 ja。生殖の意味を加えれば区別できる |
| nawl07 | sin: 罪 → （宗教・道徳上の）罪 — 罪 だけだと crime が最も自然な答えになる |
| nawl07 | scenario: 想定・シナリオ → 想定される筋書き・シナリオ — 想定 だけだと assumption を打ちやすい |
| nawl07 | shuttle: 送迎バス → 定期往復便・シャトル — 送迎バス は shuttle の一用法で狭い |
| nawl07 | semi: 半〜・準〜 → （接頭辞）半〜・準〜 — pos が 形 だが接頭辞で、学習者は half を打ちやすい |
| nawl07 | sub: 下位の・補助の → （接頭辞）下位の・副〜 — 同じく接頭辞。形容詞 sub は普通使わない |
| nawl08 | thereby: それによって → それによって（その結果） — 同パック whereby と ja が完全に同一 |
| nawl08 | whereby: それによって → （それに）よって〜する（関係副詞） — 同パック thereby と ja が完全に同一。例文の exJa にも「それによって」が出ない |
| nawl08 | unintelligible: 聞き取れない → 理解できない・判読できない — 原義は「意味が取れない」で、「聞き取れない」だと inaudible が最も自然な答えになる（inaudible を accept に入れた） |
| nawl08 | utility: 公共料金 → 効用・有用性 — NAWL（学術）の主要義は効用・有用性。公共料金の意味なら通常 utilities と複数形 |
| nawl08 | upward: 上向きの → 上向きの・上方への — 問題なし寄りだが副詞 upwards を打つ学習者が多そう（pos 形 なので accept に入れず） |
| nawl08 | variability / variance: 「ばらつき」が両カードの ja に共通 — 互いに accept で相互参照したが、オーケストレータ側で ja の差別化（variance → 分散・差異）を検討されたい |
| nawl08 | trans: 横断の・〜を越えた → （接頭辞）横断の・越えて — 単独の形容詞としては通常使わない接頭辞 |
| nawl08 | whichever: どちらの〜でも・どの〜でも — pos 形 だが tags は adj、実際は限定詞・代名詞。別解なしで問題なし |
| tsl01 | supervisor: 上司 → 監督者・上司 — 上司 alone equally yields boss / manager; added both, but the ja does not point to supervisor specifically |
| tsl01 | client: 取引先 → 顧客・依頼人 — client is primarily a customer/retained party; 取引先 reads as business partner (学習者は partner / customer も打ちうる) |
| tsl01 | precede: 先に起こる → 〜に先立つ — the current ja reads like an intransitive event and does not evoke the transitive verb precede |
| tsl01 | compact: 小型の → 小型の・コンパクトな — same ja field also matches mini (ミニの・超小型の) in this pack; the two cards overlap |
| tsl01 | goods / merchandise: 品物 / 商品 — near-identical senses in one pack; each now accepts the other, but a learner may still see them as the same prompt |
| tsl02 | headquarter: 本社 → ja はそのままで en を headquarters にする検討 — 「本社」は通常 headquarters（例文も headquarters）。単数形 headquarter はまれで動詞扱いが主。accept に headquarters / hq を入れて対処済み |
| tsl02 | bulletin: 掲示・会報 — newsletter（会報・広報紙）と「会報」が重なり、訳だけでは 2 枚の区別がつかない。bulletin は「掲示・速報」に寄せる案 |
| tsl02 | gym: 体育館 → ジム・体育館 — TOEIC では fitness gym（ジム）の意味で出ることが多い。gymnasium と区別するなら「ジム」併記が自然 |
| tsl02 | distractor: 誤答の選択肢 — テスト用語で TOEIC 本番には出ない語。訳は正しいが学習者には answer しにくい |
| tsl02 | sunny: 晴れた — fine / clear も学校英語で「晴れた」として教わるため、訳だけでは 3 語が同列。accept で吸収済み |
| tsl02 | inspection / inspect: 検査 / 検査する — examination / check / test などと訳が重なり、訳だけで一意に決まらない（accept で吸収済み） |
| tsl03 | taker: 受験者・受け取る人 → 受ける人・受け取る人（test ___） — 単独の taker は「受験者」にならず、ja から taker を思いつきにくい |
| tsl03 | utility: 公共料金 → 公共サービス・公共料金（___ costs） — 「公共料金」は通常 utilities／utility bill。単数 utility は公益事業の意味 |
| tsl03 | leak: 漏れる・漏れ → 漏れる — pos は 動 だが ja に名詞「漏れ」も併記されている |
| tsl03 | sightsee: 観光する → 観光する（go ___ing） — 原形 sightsee はほとんど使われず、学習者は sightseeing／tour を打ちやすい |
| tsl03 | congratulation: 祝いの言葉 → 祝いの言葉（通例 ___s） — 実際には複数形 congratulations が標準で単数は letter of congratulation など限定的 |
| tsl03 | trainee / intern: 研修生 / 実習生 — 同一パック内で訳が近く、互いに入れ替えて打ちやすい（両方に相互 accept を付けた） |
| tsl03 | grocery: 食料品（店） — 学習者は supermarket を打ちやすいが訳とずれるため accept は付けなかった。「食料雑貨」などの方が grocery に近い |
| tsl04 | pant: ズボン → 「ズボン（通常 pants）」または en を pants に — 学習者は pants と打つが単数形 pant では答えに辿り着きにくい |
| tsl04 | economical: 経済的な → 「経済的な・節約になる」 — 「経済的な」だけでは economic（経済の）と区別できない。economic を accept に入れた |
| tsl04 | packet: 一包み・資料一式 → 「小包・（資料の）一式」 — 一包み は package/pack と区別がつかない |
| tsl04 | seeker: 求める人・求職者 → 「（職などを）求める人」 — 求職者 は job seeker / applicant を連想させ、単語 seeker 単独に結びつきにくい |
| tsl04 | orientation: 新人研修 → 「オリエンテーション・新人研修」 — 新人研修 だけでは training と答えたくなる |
| tsl05 | bake: 焼く → オーブンで焼く — 焼くだけでは roast / grill / fry / toast など複数の語が同じ訳になる（roast, grill は accept に入れた） |
| tsl05 | portfolio: 事業構成 → ポートフォリオ・作品集 — TOEIC では投資・作品集の意味が多く、事業構成だけでは語を思いつきにくい |
| tsl05 | superior: 優れた・上位の → 上位の・上役の — 優れた側は excellent など多数の語が重なる |
| tsl05 | considerably: かなり → 相当に・大幅に — かなりは quite / fairly / rather など多くの語と重なる |
| tsl05 | statue: 像 → 彫像 — 像だけでは image / figure / sculpture とも読める |
| tsl05 | overhead: 間接費 → 諸経費・間接費 — 名詞の間接費は indirect-cost と読む学習者もいる |
| tsl06 | preliminary: 予備の → 予備的な・事前の — 「予備の」だと spare（予備のタイヤ）を打つ学習者が多い。preparatory の意味である「予備的な」が安全 |
| tsl06 | mentor: 指導者 → 助言者・メンター — 「指導者」は leader／instructor も正解になりうる訳で、mentor 固有の意味（経験者としての助言役）が伝わらない |
| tsl06 | institute: 研究所 → 協会・研究機関 — laboratory／lab も「研究所」。TOEIC では institute は機関名として出るので「研究機関・協会」の方が的確 |
| tsl06 | postage: 送料 → 郵便料金 — 「送料」なら shipping／freight／carriage も正解。郵便の料金という限定が落ちている |
| tsl06 | recruitment: 採用 → 人材採用・募集 — 「採用」はアイデアの採用（adoption）とも読める |
| tsl06 | generic: 一般的な・ノーブランドの → ノーブランドの・総称の — 「一般的な」だと general／common を打つ学習者が多く、generic の中心義から遠い |
| tsl06 | candy: あめ・菓子 → キャンディー・あめ — 「菓子」だと sweets／snack／confectionery まで広がる |
| tsl07 | compatible: 両立できる → 互換性のある・両立できる — TOEIC では機器・ソフトの互換性の意味が主。例文は両立だが訳だけでは compatible に結びつきにくい |
| tsl07 | cosmetic: 化粧品 → 化粧品の・化粧用の — 名詞「化粧品」は通例 cosmetics。例文 cosmetic company も形容詞用法で、単数 cosmetic を名詞訳で出すと cosmetics と打たれる |
| tsl07 | spa: 温泉施設 → スパ・温泉施設 — spa は温泉に限らない。学習者は hot-spring 系を連想しやすい |
| tsl07 | forum: 掲示板 → フォーラム・掲示板 — 掲示板だけだと bulletin board／notice board を連想する。オンラインの意味であることが訳から分かりにくい |
| tsl07 | graphics: 図や画像 → 図版・グラフィックス — 訳が説明的で、image／figure／picture など別の語を打ちやすい |
| tsl08 | amenity: 備え付け品 → 設備・アメニティ — TOEIC での amenity はホテル等の「設備・快適さ」。備え付け品だと fixture / furnishing を打たれやすい |
| tsl08 | reflexive: 反射的な → 再帰の（文法）・反射的な — TOEIC/一般では reflexive pronoun の「再帰の」が主。反射的な だけだと reflex を打たれる |
| tsl08 | grill: 焼く・網焼きにする → 網焼きにする — 「焼く」が広すぎて bake / fry / toast 等も正解になりうる（accept には roast / broil / barbecue のみ入れた） |
| tsl08 | pole: 棒・柱 → 棒・ポール — 「柱」は pillar / post / column が先に浮かぶ（accept に rod / stick / pillar を入れたが post / column も正解になりうる） |
| tsl08 | teen: 十代の若者 → 十代（の若者）・ティーン — 学習者は teenager を先に打つ（accept 済み）が、ja がカタカナを含むと teen に寄せやすい |
| tsl09 | cage: かご・おり → 鳥かご・おり — 「かご」単独では basket（買い物かご）を連想しやすい（basket を accept に入れてあるが、訳を絞れば不要） |
| tsl09 | sue: 訴える → 訴訟を起こす — 「訴える」は appeal（訴求する）・complain（痛みを訴える）の意味もあり、訳だけでは sue に決まらない |
| tsl09 | formally / officially: 正式に / 公式に — ほぼ同義の訳が同一パックに2枚あり学習者が取り違える（互いを accept に入れてある） |
| tsl09 | transmission: 伝達・送信 → 送信・伝送 — 「伝達」だけなら communication / delivery も浮かぶ |
| tsl09 | ward: 病棟・区 → 病棟・（行政の）区 — 「区」だけでは district / section も正解になりうる |
| tsl09 | slot: 差し込み口・枠 → 差し込み口・時間枠 — 「枠」だけでは frame を連想しやすい |
| tsl10 | engagement: （会う）約束・予定 → 約束・予定（engagement）or 先約 — the ja points most learners to appointment or promise; the card's sense (a prior social/business engagement) is hard to recover from this ja |
| tsl10 | rider: （乗り物に）乗る人 → （自転車・馬などに）乗る人 — as written it covers passenger too; narrowing the vehicle type pins it to rider |
| tsl10 | salespeople: 販売員 → 販売員（複数） — the headword is the plural form but the ja is number-neutral, so learners will naturally type salesperson/salesman |
| tsl10 | housekeep: 家事をする・清掃する → 家事・清掃をする（動詞 housekeep） — housekeep is rare as a verb; the ja 清掃する invites clean, and 家事をする invites a phrase |
| tsl10 | bound: （契約に）拘束された → 義務のある・拘束された — the ja is a past-participle gloss; bound reads as an adjective here but learners may reach for obligated/obliged |
| tsl10 | diagram: 図・図表 → 図解・ダイアグラム — 図 alone is also figure/drawing/picture, 図表 is chart/table; the ja is wider than diagram |
| tsl10 | spectator: 観客 → 観客（スポーツなどの見物人） — 観客 is just as often audience (theatre/concert), which I added; a sports/event cue would disambiguate |
| tsl10 | anyhow: とにかく・いずれにせよ → いずれにせよ・ともかく — anyway is the far more frequent English for this ja; anyhow would be hard to produce from it even with accept |
| tsl11 | obligate: 義務づける・義務を負わせる / oblige: 義務づける — two cards in the same pack with effectively identical ja; a learner cannot tell which is wanted. Cross-accept added, but one of the ja could be differentiated (e.g. oblige → 義務づける・（恩恵で）恩に着せる) |
| tsl11 | stimulus: 刺激策 → 刺激・刺激策 — the ja narrows to the economic sense only, while inspiration's ja 刺激 in this pack also invites stimulus; consider aligning |
| tsl11 | serial: 連続の・通し番号の → 連続の・連番の — 通し番号の is a noun-adjunct gloss; 連番の reads more naturally as an adjective |
| tsl11 | sedan: セダン（乗用車） → セダン — the parenthetical 乗用車 invites plain car as an answer |
| tsl11 | wellness: 健康・健康増進 → 健康増進・ウェルネス — 健康 alone maps to health, which is already a very common NGSL word |
