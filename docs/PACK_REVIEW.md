# 分野パック 精度レビュー記録

執筆したのとは別のエージェントが1枚ずつ通読し、事実・年で変わる数字・答えの曖昧さ・別解・表現を修正した記録。
「要確認」は、レビュー後も業界の人に見てもらいたいカード（id）。単語帳ページ → 該当パック → 「気になる点を送る」で指摘を受け付けている。

共通ブリーフ: 事実誤りの修正／年依存の数字は削除か「目安」／q は答えが1つに決まるように・答えの別名を q に入れない／explain は ja 以上の実務情報／accept は本物の別名だけ／助言に読める表現・断定の緩和。

## 2026-09-12 第1回（分野パック36本）

### ビジネス・バックオフィス（会計・法務・人事・税務・人材・入札）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| accounting | 3 | 当期純利益の説明（特別損益は「加減」）、前受金の別解から前受収益を除去、引当金の別解を種類名でなく別名に | acc-insolvency（上場廃止基準の記述）、acc-marginal-profit（貢献利益を別解のまま） |
| legal | 5 | 反社条項の「条例で努力義務」を断定から緩和、契約締結・甲・電子署名・利用規約など別解の整理 | law-subcontract-act（取適法の規模要件の書き方）、law-quasi-mandate（委任契約／SES契約を別解のまま） |
| hr | 12 | 退職届の別解から退職願を除去、管理監督者の別解重複、離職票≠離職証明書、人材紹介カードの q を手法の説明に、労基署・年末調整・MBO・36協定の断定を緩和、縁故採用を除去 | hr-stress-check（2025年改正で対象拡大、カードは範囲に触れず）、hr-unemployment-benefit（給付制限の書き方） |
| freelancetax | 2 | フリーランス新法「資本金要件がなく」→「規模要件がなく」、第1号被保険者を別解から除去 | ftax-enterprise-tax（文筆業を非課税例に）、ftax-books（原則7年を構造的事実として維持） |
| staffing | 13 | 労使協定方式の別解に反対の方式が入っていたのを除去、KPI系カードで件数や逆指標を別解にしていたのを除去、偽装請負の「みなし」を条件付きに、リファレンス≠バックグラウンド等 | staff-placement-fee（30〜35%の目安）、staff-non-renewal（30日前予告の条件） |
| publicbid | 4 | 不落随契を自動でなく「交渉することがある」に、入札保証金は入札金額基準、意見招請・カルテルを別解から除去 | bid-payment-delay-law（40日/30日）、bid-estimated-price（事前公表は自治体で差）、bid-bid-form（税抜の慣行） |

### ビジネス（資金調達・銀行・保険・貿易・SaaS・EC）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| startupfinance | 4 | バリュエーションの別解から時価総額を除去し q を「評価額と調達額で持分と株価が決まる」に、IPO の監査要件を「申請期の前2期分」に、資本政策の造語別解を除去 | なし |
| banking | 19 | 事前審査の別解に本審査が入っていたのを除去、信用情報機関（CIC/JICC/KSC）を別解から explain へ正しく対応づけ、抵当権≠根抵当権、保証会社・リスケの断定を緩和、製品名・非別名の別解を多数除去 | bank-bill（紙の手形の終了時期）、bank-danshin |
| insurance | 15 | 名義変更＝契約者変更として定義し受取人変更と区別、過失割合の別解修正、がん保険の「免責期間」→「待ち期間」、非別名の別解を除去 | ins-grade（3等級ダウン）、ins-cooling-off（対象外の列挙）、ins-solicitor（外貨建て資格） |
| trade | 2 | インコタームズ6枚は費用・危険の分岐点を検証済み。輸出申告と保税地域の手続き順序（申告→搬入後に許可）と保税地域の定義を修正 | trade-advance-ruling（3年）、trade-aeo |
| saas | 4 | 稟議「必ず」を緩和、MRR の別解を月次経常売上に、商談化の別解から率を除去 | saas-magic-number（0.75/0.5 は目安） |
| ec | 12 | 返品の explain を特商法の返品特約の考え方に修正、リピート率の別解重複除去、PR表記は景表法（ステマ規制）と明記、LINE料金の表現、非別名の別解を除去 | ec-cart-abandonment（7割は目安）、ec-chargeback |

### 営業・マーケ／IT（SNS・動画・コールセンター・Web制作・プログラミング・社内SE）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| sns | 16 | プレゼント企画の景表法の扱いを「購入条件の有無で異なる」に、ステマ規制は「措置命令の対象は事業者」、Instagram固有の挙動を「媒体によっては」に一般化、q に別名が漏れていた5枚を修正 | sns-gifting（無償提供のステマ告示上の扱い）、sns-early-velocity（アルゴリズムの記述） |
| video | 14 | 解像度・粗編・肖像権（パブリシティ権は別物）などの別解整理、ビットレートの単位、ショートの機能名を一般化 | video-browse／video-suggested（YouTubeの流入元名称）、video-end-screen（20秒の仕様） |
| callcenter | 7 | IVR・録音・WFM の q から別名を除去、SMS「開封率が高い」を緩和、KYC を別解から除去 | cc-customer-harassment（法改正の施行時期）、cc-utilization／cc-occupancy（定義がベンダーで異なる） |
| webdev | 18 | E-E-A-T の Trust→Trustworthiness、canonical と noindex の対比を正確に、GA4 のイベント種別を4種類に、Git≠GitHub、非別名の別解を除去 | web-core-web-vitals（指標は改定されうる）、web-conversion（キーイベントの名称） |
| programming | 13 | Promise の別解から async/await を除去、ロールバック≠revert、製品名（npm・ESLint・JWT 等）を別解から除去 | なし |
| itsupport | 18 | Active Directory と Entra ID の関係、MFA の別解からワンタイムパスワードを除去、稟議の別解整理、UTM・NAS・製品名を別解から除去 | its-password-policy（最新ガイダンスの表現）、its-antivirus（EDR との対比の書き方） |

### 不動産・自動車・建設・製造・物流

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| realestate | 2 | 誤記「現状回復」・「告知義務」を別解から除去。媒介契約・37条書面・用途地域・新耐震などの制度記述は構造的で現行と確認 | なし |
| usedcar | 2 | 電子車検証を前提に「券面に書かれている」→「記録事項・ICタグで確認」に。出張買取のクーリングオフ適用除外、印鑑証明3か月、軽自動車税に還付なしは確認済み | car-gengaku（二重査定と減額の別解の範囲） |
| mechanic | 4 | 車検の別解から制度名を除去、下回り点検≠足回り点検、法定費用の別解から諸費用を除去、電子車検証の表現 | mech-side-slip（5mm/m）、mech-obd-inspection（別解 OBD） |
| construction | 1 | ゼネコンの q から別名「総合建設会社」を除去。職長教育・2m・玉掛け1t・施工体制台帳・排出事業者＝元請は確認済み | cons-full-harness（特別教育の条件） |
| manufacturing | 1 | 治具の誤記「冶具」を別解から除去 | mfg-kensa-seisekisho（ミルシートを別解に） |
| logistics | 1 | 3PL「荷主でも運送会社でもない」→「荷主の立場に立つ第三者」に。改善基準告示は数字なしの構造記述 | logi-forwarder（別解「乙仲」は古い呼称） |

### 店舗・サービス（保育・飲食・ホテル・アパレル・サロン・印刷）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| childcare | 6 | 認可保育所の q から「認可」を除去、WBGT の説明を環境省の表現に、「魔の2歳児」を除去、解説書≠指針 | child-return-permit（意見書／登園届の扱い） |
| restaurant | 8 | 検便の対象菌を訂正（ノロは別検査）、食品衛生責任者の掲示は自治体差、口コミの表現をステマ規制に沿って、q に別名が漏れていた3枚 | rest-takeout（略称 TO）、rest-hoshokin（保証金の月数） |
| hotel | 6 | 清掃・延長などの一般語を別解から除去、q に別名が漏れていた3枚、防火管理者は30人基準を維持 | hotel-inclusive（税サ込）、hotel-lost-and-found（遺失物法の簡略化） |
| apparel | 10 | AW の q から「秋冬」を除去、交差比率の別解から式を除去、お直しの下位語を別解から除去、粗利≠粗利率など | app-sv（SV と AM を別役職にする会社） |
| salon | 6 | キャンセル料の助言調を運用の説明に、独立の別解から「のれん分け」を除去、q に別名が漏れていた4枚 | salon-material-ratio／labor-ratio（目安の幅）、salon-mirror-rental |
| printing | 6 | ノンブルの表紙の扱いを製品による表現に、T目/Y目・4色・部数・箔・キロを別解や q から整理 | print-basis-weight（連量の目安）、print-woodfree（別解 普通紙） |

### 医療・福祉・セキュリティ（セキュリティ・医療事務・看護・薬局・介護・歯科）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| security | 11 | 多要素認証≠二段階認証（説明で区別）、DDoS の別解から DoS を除去、CIA の単文字別解を除去、APT・電子サイン・SSL化・不アク法など不正確な別解を整理 | なし |
| medical | 14 | 保険証カードを前提にした q を資格確認の現状に、マイナ保険証の別解（カード≠制度）、査定と再請求の矛盾、紹介状・領収書の断定を緩和、Do の語源 | med-hokensho（受付運用の表現）、med-do（語源） |
| nursing | 20 | 臨床判断に踏み込む記述（SpO2・血糖・酸素・輸血の数値）を削除し「施設の基準に沿って」に、インスリン単位表記の説明の誤りを訂正、転倒転落「最多」を緩和、非別名の別解を多数除去 | nurs-fall（インシデントの最多区分）、nurs-six-rights（5R/6R の呼称） |
| pharmacy | 18 | 劇薬と毒薬を区別、残薬確認欄は2択、ジェネリック変更は患者同意、疑義照会の誤字別解、副作用≠有害事象など別解整理 | pharm-management-fee（旧称を別解に）、pharm-refill |
| care | 14 | 監査と運営指導を区別、体位変換「2時間ごと」を計画に沿ってに、BPSD の徘徊→歩き回り、口腔ケア「最も効果がある」を緩和、非別名の別解を除去 | care-manager（自己負担なしの言い切り）、care-roken（薬代の施設負担） |
| dental | 16 | ポケット測定の数値基準を削除、義歯・クラウン・麻酔・顎関節症などの別解を下位語や道具名から整理、仮歯「必ず」を緩和、PMTC の保険/自費説明 | dent-pmtc（保険内 PMTC の表現）、dent-fluoride（30分の飲食制限） |

### まとめ（第1回）

- 36本・1,972枚を全数レビュー。修正 約320枚。主な傾向: (1) 別解に「下位概念・関連語・製品名」が混ざる、(2) q に別解の語が漏れる、(3) 医療・法務で断定や助言に読める表現、(4) 年で変わる数字。
- 「要確認」は各パック0〜3枚。業界の人に見てもらう優先リストとして使う。

## 2026-09-12 第2回（レベル別・文法・義務教育）

### 英検 5級〜1級（7本・840語）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| eiken5 | 0 | 誤りなし。level の付け方にむらあり（例: notebook が hard） | なし |
| eiken4 | 1 | afraid 恐れて→怖がって | なし |
| eiken3 | 2 | recycle 再利用する→リサイクルする、ocean 大洋→海・大洋。problem／idea／important／future は4級相当の可能性 | なし |
| eikenp2 | 2 | prefer・extremely の訳を試験で問われる意味に | なし |
| eiken2 | 4 | corporation 大企業→企業・法人、legislation、widespread、adequate（sufficient と同訳だった） | bacteria（複数形のまま） |
| eikenp1 | 5 | deduce／ponder／denounce が類義語と同訳だったのを区別、marginal、paradigm | なし |
| eiken1 | 5 | insidious・parsimonious・laconic・disenfranchise・extrapolate の訳を一般的な語義に | entropy（専門語） |

pos・綴り・id・ジャンルは全数確認で誤りなし。7本をまたぐ重複 0。

### TOEIC 500〜990（5本・601語）

| パック | 修正 | 主な修正内容 | 要確認 |
|---|---|---|---|
| toeic500 | 6 | request を名詞「依頼・要請」に、copy「部」→「写し」、offer・flight・item・manager の訳をビジネスの語義に | なし |
| toeic600 | 6 | benefit「福利厚生」、deposit「頭金・保証金」、transfer を動詞の訳に、due を形容詞の訳に、assignment・reminder | access（利用・接続）、issue（「号」の意味も） |
| toeic730 | 5 | fiscal「会計年度の」、revenue「収入・売上高」（収益は利益寄り）、payroll、authorize、bid のジャンルを contract に | accountant（経理担当者の意味も） |
| toeic860 | 5 | prospective「見込みの・将来の」（「見込みのある」は誤り）、adhere「（規則を）守る」、incur、overhead、occupancy | compliance（順守／遵守の表記） |
| toeic990 | 4 | amortize に会計の「償却する」、severance「解雇・退職手当」、attrition、testimonial | clientele のジャンル |

綴り・pos・id・重複（5本間）は誤りなし。
