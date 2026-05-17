#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const MOBILE_BASE = path.join(ROOT, "artifacts/kharagolf-mobile/i18n/locales");
const WEB_BASE = path.join(ROOT, "artifacts/kharagolf-web/src/i18n/locales");

const ALL_LANG_NAMES = {
  en:"English",hi:"हिंदी",ar:"العربية",es:"Español",fr:"Français",
  de:"Deutsch",pt:"Português",ja:"日本語",ko:"한국어",zh:"中文(简体)",
  th:"ภาษาไทย",ms:"Bahasa Melayu",id:"Bahasa Indonesia",vi:"Tiếng Việt",
  fil:"Filipino",sw:"Kiswahili",af:"Afrikaans",am:"አማርኛ",
  ha:"Hausa",zu:"isiZulu",yo:"Yorùbá"
};

const LANGS = {
  es:{loading:"Cargando...",save:"Guardar",cancel:"Cancelar",delete:"Eliminar",edit:"Editar",confirm:"Confirmar",close:"Cerrar",back:"Atrás",next:"Siguiente",submit:"Enviar",search:"Buscar",error:"Error",success:"Éxito",noData:"No hay datos disponibles",yes:"Sí",no:"No",ok:"OK",status:"Estado",date:"Fecha",name:"Nombre",email:"Correo electrónico",phone:"Teléfono",language:"Idioma",selectLanguage:"Seleccionar idioma",languageSaved:"Preferencia de idioma guardada",active:"Activo",paid:"Pagado",unpaid:"No pagado",pending:"Pendiente",draft:"Borrador",upcoming:"Próximo",completed:"Completado",cancelled:"Cancelado",logout:"Cerrar sesión",login:"Iniciar sesión",register:"Registrarse",profile:"Perfil",settings:"Configuración",share:"Compartir",download:"Descargar",refresh:"Actualizar",viewAll:"Ver todo",home:"Inicio",play:"Jugar",compete:"Competir",club:"Club",me:"Yo",tournaments:"Torneos",leagues:"Ligas",leaderboard:"Clasificación",scoring:"Puntuación",notifications:"Notificaciones",schedule:"Horario",teeBookings:"Reservas de salida",generalPlay:"Juego general",handicap:"Hándicap",guestPasses:"Pases de invitado",caddies:"Caddies",greetMorning:"Buenos días",greetAfternoon:"Buenas tardes",greetEvening:"Buenas noches",featuredEvent:"EVENTO DESTACADO",yourActivity:"TU ACTIVIDAD",quickActions:"ACCIONES RÁPIDAS",myEvents:"MIS EVENTOS",clubFeedSection:"NOTICIAS DEL CLUB",dateTBD:"Fecha por confirmar",live:"EN VIVO",upcomingLabel:"PRÓXIMO",joinWaitlist:"Unirse a lista de espera",registerNow:"Registrarse ahora",viewLeaderboard:"Ver clasificación",justNow:"ahora mismo",minutesAgo:"hace {{n}}m",hoursAgo:"hace {{n}}h",whsIndex:"Índice WHS",bestRound:"Mejor ronda",grossStrokes:"Golpes brutos",avgPerHole:"Prom / Hoyo",strokes:"Golpes",teeBookingsSub:"Reserva un horario",score:"Puntuación",scoreSub:"Registrar una ronda",competeSub:"Torneos y ligas",clubFeed:"Noticias del club",clubFeedSub:"Publicaciones de miembros",member:"Miembro",noFeed:"Sin publicaciones aún",golfer:"Golfista",myProfile:"Mi perfil",editProfile:"Editar perfil",displayName:"Nombre para mostrar",handicapIndex:"Índice de hándicap",memberSince:"Miembro desde",changePhoto:"Cambiar foto",changePassword:"Cambiar contraseña",tournamentsPlayed:"Torneos jugados",averageScore:"Puntuación promedio",logOut:"Cerrar sesión",confirmLogout:"¿Estás seguro de que quieres cerrar sesión?",myTournaments:"Mis torneos",myLeagues:"Mis ligas",myScores:"Mis puntuaciones",profileUpdated:"Perfil actualizado correctamente",worldHandicap:"Índice de Hándicap Mundial",round:"Ronda",hole:"Hoyo",putts:"Putts",par:"Par",gross:"Bruto",net:"Neto",totalScore:"Puntuación total",submitScore:"Enviar puntuación",scorecard:"Tarjeta de puntuación",frontNine:"9 del frente",backNine:"9 de atrás",total:"Total"},
  fr:{loading:"Chargement...",save:"Enregistrer",cancel:"Annuler",delete:"Supprimer",edit:"Modifier",confirm:"Confirmer",close:"Fermer",back:"Retour",next:"Suivant",submit:"Envoyer",search:"Rechercher",error:"Erreur",success:"Succès",noData:"Aucune donnée disponible",yes:"Oui",no:"Non",ok:"OK",status:"Statut",date:"Date",name:"Nom",email:"E-mail",phone:"Téléphone",language:"Langue",selectLanguage:"Sélectionner la langue",languageSaved:"Préférence de langue enregistrée",active:"Actif",paid:"Payé",unpaid:"Non payé",pending:"En attente",draft:"Brouillon",upcoming:"À venir",completed:"Terminé",cancelled:"Annulé",logout:"Déconnexion",login:"Connexion",register:"S'inscrire",profile:"Profil",settings:"Paramètres",share:"Partager",download:"Télécharger",refresh:"Actualiser",viewAll:"Voir tout",home:"Accueil",play:"Jouer",compete:"Compétition",club:"Club",me:"Moi",tournaments:"Tournois",leagues:"Ligues",leaderboard:"Classement",scoring:"Score",notifications:"Notifications",schedule:"Programme",teeBookings:"Réservations de départ",generalPlay:"Jeu général",handicap:"Handicap",guestPasses:"Passes invité",caddies:"Caddies",greetMorning:"Bonjour",greetAfternoon:"Bon après-midi",greetEvening:"Bonsoir",featuredEvent:"ÉVÉNEMENT VEDETTE",yourActivity:"VOTRE ACTIVITÉ",quickActions:"ACTIONS RAPIDES",myEvents:"MES ÉVÉNEMENTS",clubFeedSection:"FIL DU CLUB",dateTBD:"Date à confirmer",live:"EN DIRECT",upcomingLabel:"À VENIR",joinWaitlist:"Rejoindre la liste d'attente",registerNow:"S'inscrire maintenant",viewLeaderboard:"Voir le classement",justNow:"à l'instant",minutesAgo:"il y a {{n}}m",hoursAgo:"il y a {{n}}h",whsIndex:"Indice WHS",bestRound:"Meilleur tour",grossStrokes:"Coups bruts",avgPerHole:"Moy / Trou",strokes:"Coups",teeBookingsSub:"Réserver un créneau",score:"Score",scoreSub:"Enregistrer un tour",competeSub:"Tournois et ligues",clubFeed:"Fil du club",clubFeedSub:"Publications des membres",member:"Membre",noFeed:"Aucune publication pour l'instant",golfer:"Golfeur",myProfile:"Mon profil",editProfile:"Modifier le profil",displayName:"Nom d'affichage",handicapIndex:"Indice de handicap",memberSince:"Membre depuis",changePhoto:"Changer la photo",changePassword:"Changer le mot de passe",tournamentsPlayed:"Tournois joués",averageScore:"Score moyen",logOut:"Déconnexion",confirmLogout:"Êtes-vous sûr de vouloir vous déconnecter ?",myTournaments:"Mes tournois",myLeagues:"Mes ligues",myScores:"Mes scores",profileUpdated:"Profil mis à jour avec succès",worldHandicap:"Indice de handicap mondial",round:"Tour",hole:"Trou",putts:"Putts",par:"Par",gross:"Brut",net:"Net",totalScore:"Score total",submitScore:"Soumettre le score",scorecard:"Carte de score",frontNine:"9 premiers",backNine:"9 derniers",total:"Total"},
  de:{loading:"Laden...",save:"Speichern",cancel:"Abbrechen",delete:"Löschen",edit:"Bearbeiten",confirm:"Bestätigen",close:"Schließen",back:"Zurück",next:"Weiter",submit:"Absenden",search:"Suchen",error:"Fehler",success:"Erfolg",noData:"Keine Daten verfügbar",yes:"Ja",no:"Nein",ok:"OK",status:"Status",date:"Datum",name:"Name",email:"E-Mail",phone:"Telefon",language:"Sprache",selectLanguage:"Sprache auswählen",languageSaved:"Spracheinstellung gespeichert",active:"Aktiv",paid:"Bezahlt",unpaid:"Unbezahlt",pending:"Ausstehend",draft:"Entwurf",upcoming:"Bevorstehend",completed:"Abgeschlossen",cancelled:"Abgebrochen",logout:"Abmelden",login:"Anmelden",register:"Registrieren",profile:"Profil",settings:"Einstellungen",share:"Teilen",download:"Herunterladen",refresh:"Aktualisieren",viewAll:"Alle anzeigen",home:"Startseite",play:"Spielen",compete:"Wettkampf",club:"Club",me:"Ich",tournaments:"Turniere",leagues:"Ligen",leaderboard:"Rangliste",scoring:"Wertung",notifications:"Benachrichtigungen",schedule:"Zeitplan",teeBookings:"Abschlagbuchungen",generalPlay:"Allgemeines Spiel",handicap:"Handicap",guestPasses:"Gastpässe",caddies:"Caddies",greetMorning:"Guten Morgen",greetAfternoon:"Guten Tag",greetEvening:"Guten Abend",featuredEvent:"HIGHLIGHTS",yourActivity:"IHRE AKTIVITÄT",quickActions:"SCHNELLAKTIONEN",myEvents:"MEINE EVENTS",clubFeedSection:"CLUB-FEED",dateTBD:"Datum TBD",live:"LIVE",upcomingLabel:"BEVORSTEHEND",joinWaitlist:"Warteliste beitreten",registerNow:"Jetzt registrieren",viewLeaderboard:"Rangliste anzeigen",justNow:"gerade eben",minutesAgo:"vor {{n}}m",hoursAgo:"vor {{n}}h",whsIndex:"WHS-Index",bestRound:"Beste Runde",grossStrokes:"Brutto-Schläge",avgPerHole:"Ø / Loch",strokes:"Schläge",teeBookingsSub:"Einen Slot reservieren",score:"Wertung",scoreSub:"Eine Runde erfassen",competeSub:"Turniere & Ligen",clubFeed:"Club-Feed",clubFeedSub:"Mitgliederbeiträge",member:"Mitglied",noFeed:"Noch keine Beiträge",golfer:"Golfer",myProfile:"Mein Profil",editProfile:"Profil bearbeiten",displayName:"Anzeigename",handicapIndex:"Handicap-Index",memberSince:"Mitglied seit",changePhoto:"Foto ändern",changePassword:"Passwort ändern",tournamentsPlayed:"Gespielte Turniere",averageScore:"Durchschnittspunktzahl",logOut:"Abmelden",confirmLogout:"Möchten Sie sich wirklich abmelden?",myTournaments:"Meine Turniere",myLeagues:"Meine Ligen",myScores:"Meine Wertungen",profileUpdated:"Profil erfolgreich aktualisiert",worldHandicap:"Welt-Handicap-Index",round:"Runde",hole:"Loch",putts:"Putts",par:"Par",gross:"Brutto",net:"Netto",totalScore:"Gesamtwertung",submitScore:"Wertung einreichen",scorecard:"Scorekarte",frontNine:"Vorderneun",backNine:"Hinterneun",total:"Gesamt"},
  pt:{loading:"Carregando...",save:"Salvar",cancel:"Cancelar",delete:"Excluir",edit:"Editar",confirm:"Confirmar",close:"Fechar",back:"Voltar",next:"Próximo",submit:"Enviar",search:"Pesquisar",error:"Erro",success:"Sucesso",noData:"Nenhum dado disponível",yes:"Sim",no:"Não",ok:"OK",status:"Status",date:"Data",name:"Nome",email:"E-mail",phone:"Telefone",language:"Idioma",selectLanguage:"Selecionar idioma",languageSaved:"Preferência de idioma salva",active:"Ativo",paid:"Pago",unpaid:"Não pago",pending:"Pendente",draft:"Rascunho",upcoming:"Próximo",completed:"Concluído",cancelled:"Cancelado",logout:"Sair",login:"Entrar",register:"Registrar",profile:"Perfil",settings:"Configurações",share:"Compartilhar",download:"Baixar",refresh:"Atualizar",viewAll:"Ver tudo",home:"Início",play:"Jogar",compete:"Competir",club:"Clube",me:"Eu",tournaments:"Torneios",leagues:"Ligas",leaderboard:"Classificação",scoring:"Pontuação",notifications:"Notificações",schedule:"Agenda",teeBookings:"Reservas de tee",generalPlay:"Jogo geral",handicap:"Handicap",guestPasses:"Passes de convidado",caddies:"Caddies",greetMorning:"Bom dia",greetAfternoon:"Boa tarde",greetEvening:"Boa noite",featuredEvent:"EVENTO DESTAQUE",yourActivity:"SUA ATIVIDADE",quickActions:"AÇÕES RÁPIDAS",myEvents:"MEUS EVENTOS",clubFeedSection:"FEED DO CLUBE",dateTBD:"Data a confirmar",live:"AO VIVO",upcomingLabel:"PRÓXIMO",joinWaitlist:"Entrar na lista de espera",registerNow:"Registrar agora",viewLeaderboard:"Ver classificação",justNow:"agora mesmo",minutesAgo:"há {{n}}m",hoursAgo:"há {{n}}h",whsIndex:"Índice WHS",bestRound:"Melhor rodada",grossStrokes:"Tacadas brutas",avgPerHole:"Méd / Buraco",strokes:"Tacadas",teeBookingsSub:"Reserve um horário",score:"Pontuação",scoreSub:"Registrar uma rodada",competeSub:"Torneios e ligas",clubFeed:"Feed do clube",clubFeedSub:"Publicações de membros",member:"Membro",noFeed:"Nenhuma publicação ainda",golfer:"Golfista",myProfile:"Meu perfil",editProfile:"Editar perfil",displayName:"Nome de exibição",handicapIndex:"Índice de handicap",memberSince:"Membro desde",changePhoto:"Alterar foto",changePassword:"Alterar senha",tournamentsPlayed:"Torneios jogados",averageScore:"Pontuação média",logOut:"Sair",confirmLogout:"Tem certeza que deseja sair?",myTournaments:"Meus torneios",myLeagues:"Minhas ligas",myScores:"Minhas pontuações",profileUpdated:"Perfil atualizado com sucesso",worldHandicap:"Índice de Handicap Mundial",round:"Rodada",hole:"Buraco",putts:"Putts",par:"Par",gross:"Bruto",net:"Líquido",totalScore:"Pontuação total",submitScore:"Enviar pontuação",scorecard:"Cartão de pontuação",frontNine:"9 da frente",backNine:"9 de trás",total:"Total"},
  ja:{loading:"読み込み中...",save:"保存",cancel:"キャンセル",delete:"削除",edit:"編集",confirm:"確認",close:"閉じる",back:"戻る",next:"次へ",submit:"送信",search:"検索",error:"エラー",success:"成功",noData:"データなし",yes:"はい",no:"いいえ",ok:"OK",status:"ステータス",date:"日付",name:"名前",email:"メール",phone:"電話",language:"言語",selectLanguage:"言語を選択",languageSaved:"言語設定を保存しました",active:"アクティブ",paid:"支払済",unpaid:"未払",pending:"保留中",draft:"下書き",upcoming:"近日",completed:"完了",cancelled:"キャンセル",logout:"ログアウト",login:"ログイン",register:"登録",profile:"プロフィール",settings:"設定",share:"共有",download:"ダウンロード",refresh:"更新",viewAll:"すべて表示",home:"ホーム",play:"プレー",compete:"競技",club:"クラブ",me:"マイページ",tournaments:"トーナメント",leagues:"リーグ",leaderboard:"リーダーボード",scoring:"スコアリング",notifications:"通知",schedule:"スケジュール",teeBookings:"ティー予約",generalPlay:"一般プレー",handicap:"ハンディキャップ",guestPasses:"ゲストパス",caddies:"キャディ",greetMorning:"おはようございます",greetAfternoon:"こんにちは",greetEvening:"こんばんは",featuredEvent:"注目イベント",yourActivity:"あなたの活動",quickActions:"クイックアクション",myEvents:"マイイベント",clubFeedSection:"クラブフィード",dateTBD:"日程未定",live:"ライブ",upcomingLabel:"予定",joinWaitlist:"キャンセル待ち登録",registerNow:"今すぐ登録",viewLeaderboard:"リーダーボードを見る",justNow:"たった今",minutesAgo:"{{n}}分前",hoursAgo:"{{n}}時間前",whsIndex:"WHSインデックス",bestRound:"ベストラウンド",grossStrokes:"グロス打数",avgPerHole:"平均/ホール",strokes:"打数",teeBookingsSub:"スロットを予約",score:"スコア",scoreSub:"ラウンドを記録",competeSub:"トーナメント＆リーグ",clubFeed:"クラブフィード",clubFeedSub:"メンバー投稿",member:"メンバー",noFeed:"まだ投稿がありません",golfer:"ゴルファー",myProfile:"マイプロフィール",editProfile:"プロフィール編集",displayName:"表示名",handicapIndex:"ハンディキャップ指数",memberSince:"会員登録日",changePhoto:"写真を変更",changePassword:"パスワードを変更",tournamentsPlayed:"参加トーナメント数",averageScore:"平均スコア",logOut:"ログアウト",confirmLogout:"本当にログアウトしますか？",myTournaments:"マイトーナメント",myLeagues:"マイリーグ",myScores:"マイスコア",profileUpdated:"プロフィールを更新しました",worldHandicap:"ワールドハンディキャップ指数",round:"ラウンド",hole:"ホール",putts:"パット",par:"パー",gross:"グロス",net:"ネット",totalScore:"合計スコア",submitScore:"スコアを提出",scorecard:"スコアカード",frontNine:"前半",backNine:"後半",total:"合計"},
  ko:{loading:"로딩 중...",save:"저장",cancel:"취소",delete:"삭제",edit:"편집",confirm:"확인",close:"닫기",back:"뒤로",next:"다음",submit:"제출",search:"검색",error:"오류",success:"성공",noData:"데이터 없음",yes:"예",no:"아니오",ok:"확인",status:"상태",date:"날짜",name:"이름",email:"이메일",phone:"전화",language:"언어",selectLanguage:"언어 선택",languageSaved:"언어 설정이 저장되었습니다",active:"활성",paid:"결제됨",unpaid:"미결제",pending:"대기 중",draft:"임시저장",upcoming:"예정",completed:"완료",cancelled:"취소됨",logout:"로그아웃",login:"로그인",register:"등록",profile:"프로필",settings:"설정",share:"공유",download:"다운로드",refresh:"새로고침",viewAll:"전체 보기",home:"홈",play:"플레이",compete:"경쟁",club:"클럽",me:"내 정보",tournaments:"토너먼트",leagues:"리그",leaderboard:"리더보드",scoring:"스코어링",notifications:"알림",schedule:"일정",teeBookings:"티 예약",generalPlay:"일반 플레이",handicap:"핸디캡",guestPasses:"게스트 패스",caddies:"캐디",greetMorning:"좋은 아침입니다",greetAfternoon:"안녕하세요",greetEvening:"안녕하세요",featuredEvent:"주요 이벤트",yourActivity:"내 활동",quickActions:"빠른 실행",myEvents:"내 이벤트",clubFeedSection:"클럽 피드",dateTBD:"날짜 미정",live:"라이브",upcomingLabel:"예정",joinWaitlist:"대기자 명단 등록",registerNow:"지금 등록",viewLeaderboard:"리더보드 보기",justNow:"방금",minutesAgo:"{{n}}분 전",hoursAgo:"{{n}}시간 전",whsIndex:"WHS 지수",bestRound:"최고 라운드",grossStrokes:"그로스 타수",avgPerHole:"평균/홀",strokes:"타수",teeBookingsSub:"슬롯 예약",score:"점수",scoreSub:"라운드 기록",competeSub:"토너먼트 & 리그",clubFeed:"클럽 피드",clubFeedSub:"회원 게시물",member:"회원",noFeed:"게시물이 없습니다",golfer:"골퍼",myProfile:"내 프로필",editProfile:"프로필 편집",displayName:"표시 이름",handicapIndex:"핸디캡 지수",memberSince:"회원 가입일",changePhoto:"사진 변경",changePassword:"비밀번호 변경",tournamentsPlayed:"참가 토너먼트",averageScore:"평균 점수",logOut:"로그아웃",confirmLogout:"로그아웃하시겠습니까?",myTournaments:"내 토너먼트",myLeagues:"내 리그",myScores:"내 스코어",profileUpdated:"프로필이 업데이트되었습니다",worldHandicap:"세계 핸디캡 지수",round:"라운드",hole:"홀",putts:"퍼트",par:"파",gross:"그로스",net:"네트",totalScore:"총 점수",submitScore:"점수 제출",scorecard:"스코어카드",frontNine:"전반 9홀",backNine:"후반 9홀",total:"합계"},
  zh:{loading:"加载中...",save:"保存",cancel:"取消",delete:"删除",edit:"编辑",confirm:"确认",close:"关闭",back:"返回",next:"下一步",submit:"提交",search:"搜索",error:"错误",success:"成功",noData:"暂无数据",yes:"是",no:"否",ok:"确定",status:"状态",date:"日期",name:"姓名",email:"电子邮件",phone:"电话",language:"语言",selectLanguage:"选择语言",languageSaved:"已保存语言偏好",active:"活跃",paid:"已付款",unpaid:"未付款",pending:"待处理",draft:"草稿",upcoming:"即将到来",completed:"已完成",cancelled:"已取消",logout:"退出登录",login:"登录",register:"注册",profile:"个人资料",settings:"设置",share:"分享",download:"下载",refresh:"刷新",viewAll:"查看全部",home:"首页",play:"打球",compete:"比赛",club:"俱乐部",me:"我的",tournaments:"锦标赛",leagues:"联赛",leaderboard:"排行榜",scoring:"计分",notifications:"通知",schedule:"赛程",teeBookings:"开球时间预约",generalPlay:"休闲打球",handicap:"差点",guestPasses:"访客通行证",caddies:"球童",greetMorning:"早上好",greetAfternoon:"下午好",greetEvening:"晚上好",featuredEvent:"特色赛事",yourActivity:"您的活动",quickActions:"快速操作",myEvents:"我的赛事",clubFeedSection:"俱乐部动态",dateTBD:"日期待定",live:"直播",upcomingLabel:"即将开始",joinWaitlist:"加入候补名单",registerNow:"立即报名",viewLeaderboard:"查看排行榜",justNow:"刚刚",minutesAgo:"{{n}}分钟前",hoursAgo:"{{n}}小时前",whsIndex:"WHS指数",bestRound:"最佳轮次",grossStrokes:"总杆数",avgPerHole:"平均/洞",strokes:"杆数",teeBookingsSub:"预约时段",score:"得分",scoreSub:"记录一轮",competeSub:"锦标赛和联赛",clubFeed:"俱乐部动态",clubFeedSub:"成员发帖",member:"会员",noFeed:"暂无发帖",golfer:"高尔夫球手",myProfile:"我的资料",editProfile:"编辑资料",displayName:"显示名称",handicapIndex:"差点指数",memberSince:"入会时间",changePhoto:"更换照片",changePassword:"修改密码",tournamentsPlayed:"参赛次数",averageScore:"平均得分",logOut:"退出登录",confirmLogout:"确定要退出登录吗？",myTournaments:"我的锦标赛",myLeagues:"我的联赛",myScores:"我的得分",profileUpdated:"个人资料已更新",worldHandicap:"世界差点指数",round:"轮次",hole:"洞",putts:"推杆",par:"标准杆",gross:"总杆",net:"净杆",totalScore:"总分",submitScore:"提交得分",scorecard:"成绩卡",frontNine:"前九洞",backNine:"后九洞",total:"合计"},
  th:{loading:"กำลังโหลด...",save:"บันทึก",cancel:"ยกเลิก",delete:"ลบ",edit:"แก้ไข",confirm:"ยืนยัน",close:"ปิด",back:"กลับ",next:"ถัดไป",submit:"ส่ง",search:"ค้นหา",error:"ข้อผิดพลาด",success:"สำเร็จ",noData:"ไม่มีข้อมูล",yes:"ใช่",no:"ไม่",ok:"ตกลง",status:"สถานะ",date:"วันที่",name:"ชื่อ",email:"อีเมล",phone:"โทรศัพท์",language:"ภาษา",selectLanguage:"เลือกภาษา",languageSaved:"บันทึกการตั้งค่าภาษาแล้ว",active:"ใช้งาน",paid:"ชำระแล้ว",unpaid:"ยังไม่ชำระ",pending:"รอดำเนินการ",draft:"แบบร่าง",upcoming:"กำลังมา",completed:"เสร็จสิ้น",cancelled:"ยกเลิก",logout:"ออกจากระบบ",login:"เข้าสู่ระบบ",register:"ลงทะเบียน",profile:"โปรไฟล์",settings:"การตั้งค่า",share:"แชร์",download:"ดาวน์โหลด",refresh:"รีเฟรช",viewAll:"ดูทั้งหมด",home:"หน้าหลัก",play:"เล่น",compete:"แข่งขัน",club:"สโมสร",me:"ฉัน",tournaments:"ทัวร์นาเมนต์",leagues:"ลีก",leaderboard:"กระดานผู้นำ",scoring:"การให้คะแนน",notifications:"การแจ้งเตือน",schedule:"ตารางเวลา",teeBookings:"จองเวลาตี",generalPlay:"เล่นทั่วไป",handicap:"แฮนดิแคป",guestPasses:"บัตรผ่านแขก",caddies:"แคดดี้",greetMorning:"อรุณสวัสดิ์",greetAfternoon:"สวัสดีตอนบ่าย",greetEvening:"สวัสดีตอนเย็น",featuredEvent:"กิจกรรมเด่น",yourActivity:"กิจกรรมของคุณ",quickActions:"การดำเนินการด่วน",myEvents:"กิจกรรมของฉัน",clubFeedSection:"ฟีดสโมสร",dateTBD:"วันที่ยังไม่กำหนด",live:"สด",upcomingLabel:"กำลังมา",joinWaitlist:"เข้าร่วมรายชื่อรอ",registerNow:"ลงทะเบียนเลย",viewLeaderboard:"ดูกระดานผู้นำ",justNow:"เมื่อกี้นี้",minutesAgo:"{{n}} นาทีที่แล้ว",hoursAgo:"{{n}} ชั่วโมงที่แล้ว",whsIndex:"ดัชนี WHS",bestRound:"รอบที่ดีที่สุด",grossStrokes:"จำนวนสโตรกรวม",avgPerHole:"เฉลี่ย/หลุม",strokes:"การตี",teeBookingsSub:"จองช่วงเวลา",score:"คะแนน",scoreSub:"บันทึกรอบ",competeSub:"ทัวร์นาเมนต์และลีก",clubFeed:"ฟีดสโมสร",clubFeedSub:"โพสต์ของสมาชิก",member:"สมาชิก",noFeed:"ยังไม่มีโพสต์",golfer:"นักกอล์ฟ",myProfile:"โปรไฟล์ของฉัน",editProfile:"แก้ไขโปรไฟล์",displayName:"ชื่อที่แสดง",handicapIndex:"ดัชนีแฮนดิแคป",memberSince:"สมาชิกตั้งแต่",changePhoto:"เปลี่ยนรูปภาพ",changePassword:"เปลี่ยนรหัสผ่าน",tournamentsPlayed:"ทัวร์นาเมนต์ที่เล่น",averageScore:"คะแนนเฉลี่ย",logOut:"ออกจากระบบ",confirmLogout:"คุณต้องการออกจากระบบหรือไม่?",myTournaments:"ทัวร์นาเมนต์ของฉัน",myLeagues:"ลีกของฉัน",myScores:"คะแนนของฉัน",profileUpdated:"อัปเดตโปรไฟล์สำเร็จ",worldHandicap:"ดัชนีแฮนดิแคปโลก",round:"รอบ",hole:"หลุม",putts:"การพัตต์",par:"พาร์",gross:"กรอส",net:"เน็ต",totalScore:"คะแนนรวม",submitScore:"ส่งคะแนน",scorecard:"บัตรคะแนน",frontNine:"9 หลุมหน้า",backNine:"9 หลุมหลัง",total:"รวม"},
  ms:{loading:"Memuatkan...",save:"Simpan",cancel:"Batal",delete:"Padam",edit:"Edit",confirm:"Sahkan",close:"Tutup",back:"Kembali",next:"Seterusnya",submit:"Hantar",search:"Cari",error:"Ralat",success:"Berjaya",noData:"Tiada data tersedia",yes:"Ya",no:"Tidak",ok:"OK",status:"Status",date:"Tarikh",name:"Nama",email:"E-mel",phone:"Telefon",language:"Bahasa",selectLanguage:"Pilih bahasa",languageSaved:"Keutamaan bahasa disimpan",active:"Aktif",paid:"Dibayar",unpaid:"Belum dibayar",pending:"Tertunda",draft:"Draf",upcoming:"Akan datang",completed:"Selesai",cancelled:"Dibatalkan",logout:"Log keluar",login:"Log masuk",register:"Daftar",profile:"Profil",settings:"Tetapan",share:"Kongsi",download:"Muat turun",refresh:"Muat semula",viewAll:"Lihat semua",home:"Utama",play:"Main",compete:"Bersaing",club:"Kelab",me:"Saya",tournaments:"Kejohanan",leagues:"Liga",leaderboard:"Papan Pendahulu",scoring:"Pemarkahan",notifications:"Pemberitahuan",schedule:"Jadual",teeBookings:"Tempahan waktu tee",generalPlay:"Permainan umum",handicap:"Handicap",guestPasses:"Pas tetamu",caddies:"Caddie",greetMorning:"Selamat pagi",greetAfternoon:"Selamat tengah hari",greetEvening:"Selamat petang",featuredEvent:"ACARA UTAMA",yourActivity:"AKTIVITI ANDA",quickActions:"TINDAKAN CEPAT",myEvents:"ACARA SAYA",clubFeedSection:"SUAPAN KELAB",dateTBD:"Tarikh akan dimaklumkan",live:"LANGSUNG",upcomingLabel:"AKAN DATANG",joinWaitlist:"Sertai senarai menunggu",registerNow:"Daftar sekarang",viewLeaderboard:"Lihat papan pendahulu",justNow:"baru sahaja",minutesAgo:"{{n}}m lalu",hoursAgo:"{{n}}j lalu",whsIndex:"Indeks WHS",bestRound:"Pusingan terbaik",grossStrokes:"Pukulan kasar",avgPerHole:"Purata/Lubang",strokes:"Pukulan",teeBookingsSub:"Tempah slot",score:"Skor",scoreSub:"Rekod pusingan",competeSub:"Kejohanan & liga",clubFeed:"Suapan kelab",clubFeedSub:"Siaran ahli",member:"Ahli",noFeed:"Tiada siaran lagi",golfer:"Pegolf",myProfile:"Profil saya",editProfile:"Edit profil",displayName:"Nama paparan",handicapIndex:"Indeks handicap",memberSince:"Ahli sejak",changePhoto:"Tukar foto",changePassword:"Tukar kata laluan",tournamentsPlayed:"Kejohanan dimainkan",averageScore:"Skor purata",logOut:"Log keluar",confirmLogout:"Adakah anda pasti ingin log keluar?",myTournaments:"Kejohanan saya",myLeagues:"Liga saya",myScores:"Skor saya",profileUpdated:"Profil berjaya dikemas kini",worldHandicap:"Indeks Handicap Dunia",round:"Pusingan",hole:"Lubang",putts:"Putt",par:"Par",gross:"Kasar",net:"Bersih",totalScore:"Jumlah skor",submitScore:"Hantar skor",scorecard:"Kad skor",frontNine:"9 depan",backNine:"9 belakang",total:"Jumlah"},
  id:{loading:"Memuat...",save:"Simpan",cancel:"Batal",delete:"Hapus",edit:"Edit",confirm:"Konfirmasi",close:"Tutup",back:"Kembali",next:"Lanjut",submit:"Kirim",search:"Cari",error:"Kesalahan",success:"Berhasil",noData:"Tidak ada data tersedia",yes:"Ya",no:"Tidak",ok:"OK",status:"Status",date:"Tanggal",name:"Nama",email:"Email",phone:"Telepon",language:"Bahasa",selectLanguage:"Pilih bahasa",languageSaved:"Preferensi bahasa tersimpan",active:"Aktif",paid:"Dibayar",unpaid:"Belum dibayar",pending:"Tertunda",draft:"Draf",upcoming:"Akan datang",completed:"Selesai",cancelled:"Dibatalkan",logout:"Keluar",login:"Masuk",register:"Daftar",profile:"Profil",settings:"Pengaturan",share:"Bagikan",download:"Unduh",refresh:"Segarkan",viewAll:"Lihat semua",home:"Beranda",play:"Main",compete:"Kompetisi",club:"Klub",me:"Saya",tournaments:"Turnamen",leagues:"Liga",leaderboard:"Papan Peringkat",scoring:"Penilaian",notifications:"Notifikasi",schedule:"Jadwal",teeBookings:"Pemesanan waktu tee",generalPlay:"Permainan umum",handicap:"Handicap",guestPasses:"Tiket tamu",caddies:"Caddie",greetMorning:"Selamat pagi",greetAfternoon:"Selamat siang",greetEvening:"Selamat malam",featuredEvent:"ACARA UNGGULAN",yourActivity:"AKTIVITAS ANDA",quickActions:"AKSI CEPAT",myEvents:"ACARA SAYA",clubFeedSection:"FEED KLUB",dateTBD:"Tanggal menyusul",live:"LANGSUNG",upcomingLabel:"AKAN DATANG",joinWaitlist:"Bergabung daftar tunggu",registerNow:"Daftar sekarang",viewLeaderboard:"Lihat papan peringkat",justNow:"baru saja",minutesAgo:"{{n}}m lalu",hoursAgo:"{{n}}j lalu",whsIndex:"Indeks WHS",bestRound:"Putaran terbaik",grossStrokes:"Pukulan kotor",avgPerHole:"Rata-rata/Lubang",strokes:"Pukulan",teeBookingsSub:"Pesan slot",score:"Skor",scoreSub:"Catat putaran",competeSub:"Turnamen & liga",clubFeed:"Feed klub",clubFeedSub:"Posting anggota",member:"Anggota",noFeed:"Belum ada posting",golfer:"Pegolf",myProfile:"Profil saya",editProfile:"Edit profil",displayName:"Nama tampilan",handicapIndex:"Indeks handicap",memberSince:"Anggota sejak",changePhoto:"Ganti foto",changePassword:"Ganti kata sandi",tournamentsPlayed:"Turnamen dimainkan",averageScore:"Skor rata-rata",logOut:"Keluar",confirmLogout:"Apakah Anda yakin ingin keluar?",myTournaments:"Turnamen saya",myLeagues:"Liga saya",myScores:"Skor saya",profileUpdated:"Profil berhasil diperbarui",worldHandicap:"Indeks Handicap Dunia",round:"Putaran",hole:"Lubang",putts:"Putt",par:"Par",gross:"Gross",net:"Net",totalScore:"Total skor",submitScore:"Kirim skor",scorecard:"Kartu skor",frontNine:"9 depan",backNine:"9 belakang",total:"Total"},
  vi:{loading:"Đang tải...",save:"Lưu",cancel:"Hủy",delete:"Xóa",edit:"Chỉnh sửa",confirm:"Xác nhận",close:"Đóng",back:"Quay lại",next:"Tiếp theo",submit:"Gửi",search:"Tìm kiếm",error:"Lỗi",success:"Thành công",noData:"Không có dữ liệu",yes:"Có",no:"Không",ok:"OK",status:"Trạng thái",date:"Ngày",name:"Tên",email:"Email",phone:"Điện thoại",language:"Ngôn ngữ",selectLanguage:"Chọn ngôn ngữ",languageSaved:"Đã lưu tùy chọn ngôn ngữ",active:"Hoạt động",paid:"Đã thanh toán",unpaid:"Chưa thanh toán",pending:"Đang chờ",draft:"Nháp",upcoming:"Sắp tới",completed:"Hoàn thành",cancelled:"Đã hủy",logout:"Đăng xuất",login:"Đăng nhập",register:"Đăng ký",profile:"Hồ sơ",settings:"Cài đặt",share:"Chia sẻ",download:"Tải xuống",refresh:"Làm mới",viewAll:"Xem tất cả",home:"Trang chủ",play:"Chơi",compete:"Thi đấu",club:"Câu lạc bộ",me:"Tôi",tournaments:"Giải đấu",leagues:"Giải",leaderboard:"Bảng xếp hạng",scoring:"Tính điểm",notifications:"Thông báo",schedule:"Lịch trình",teeBookings:"Đặt giờ tee",generalPlay:"Chơi thông thường",handicap:"Handicap",guestPasses:"Thẻ khách",caddies:"Caddie",greetMorning:"Chào buổi sáng",greetAfternoon:"Chào buổi chiều",greetEvening:"Chào buổi tối",featuredEvent:"SỰ KIỆN NỔI BẬT",yourActivity:"HOẠT ĐỘNG CỦA BẠN",quickActions:"THAO TÁC NHANH",myEvents:"SỰ KIỆN CỦA TÔI",clubFeedSection:"NGUỒN CÂU LẠC BỘ",dateTBD:"Ngày sẽ thông báo",live:"TRỰC TIẾP",upcomingLabel:"SẮP TỚI",joinWaitlist:"Đăng ký danh sách chờ",registerNow:"Đăng ký ngay",viewLeaderboard:"Xem bảng xếp hạng",justNow:"vừa xong",minutesAgo:"{{n}}p trước",hoursAgo:"{{n}}h trước",whsIndex:"Chỉ số WHS",bestRound:"Vòng đấu tốt nhất",grossStrokes:"Tổng gậy",avgPerHole:"Trung bình/lỗ",strokes:"Gậy",teeBookingsSub:"Đặt khung giờ",score:"Điểm",scoreSub:"Ghi lại vòng đấu",competeSub:"Giải đấu & giải",clubFeed:"Nguồn câu lạc bộ",clubFeedSub:"Bài đăng của thành viên",member:"Thành viên",noFeed:"Chưa có bài đăng",golfer:"Golfer",myProfile:"Hồ sơ của tôi",editProfile:"Chỉnh sửa hồ sơ",displayName:"Tên hiển thị",handicapIndex:"Chỉ số handicap",memberSince:"Thành viên từ",changePhoto:"Đổi ảnh",changePassword:"Đổi mật khẩu",tournamentsPlayed:"Giải đấu đã tham gia",averageScore:"Điểm trung bình",logOut:"Đăng xuất",confirmLogout:"Bạn có chắc muốn đăng xuất?",myTournaments:"Giải đấu của tôi",myLeagues:"Giải của tôi",myScores:"Điểm của tôi",profileUpdated:"Đã cập nhật hồ sơ thành công",worldHandicap:"Chỉ số Handicap Thế giới",round:"Vòng",hole:"Lỗ",putts:"Putt",par:"Par",gross:"Tổng gậy",net:"Gậy net",totalScore:"Tổng điểm",submitScore:"Gửi điểm",scorecard:"Thẻ điểm",frontNine:"9 lỗ trước",backNine:"9 lỗ sau",total:"Tổng"},
  fil:{loading:"Naglo-load...",save:"I-save",cancel:"Kanselahin",delete:"I-delete",edit:"I-edit",confirm:"Kumpirmahin",close:"Isara",back:"Bumalik",next:"Susunod",submit:"Isumite",search:"Maghanap",error:"Error",success:"Tagumpay",noData:"Walang available na data",yes:"Oo",no:"Hindi",ok:"OK",status:"Status",date:"Petsa",name:"Pangalan",email:"Email",phone:"Telepono",language:"Wika",selectLanguage:"Pumili ng wika",languageSaved:"Nai-save ang kagustuhan sa wika",active:"Aktibo",paid:"Nabayaran",unpaid:"Hindi pa nabayaran",pending:"Nakabinbin",draft:"Draft",upcoming:"Paparating",completed:"Natapos",cancelled:"Nakansela",logout:"Mag-logout",login:"Mag-login",register:"Mag-register",profile:"Profile",settings:"Mga Setting",share:"Ibahagi",download:"I-download",refresh:"I-refresh",viewAll:"Tingnan lahat",home:"Home",play:"Maglaro",compete:"Makipagsabayan",club:"Club",me:"Ako",tournaments:"Mga Tournament",leagues:"Mga Liga",leaderboard:"Leaderboard",scoring:"Pagmamarka",notifications:"Mga Notipikasyon",schedule:"Iskedyul",teeBookings:"Mga Booking sa Tee",generalPlay:"Pangkalahatang Laro",handicap:"Handicap",guestPasses:"Mga Pass ng Bisita",caddies:"Mga Caddie",greetMorning:"Magandang umaga",greetAfternoon:"Magandang hapon",greetEvening:"Magandang gabi",featuredEvent:"TAMPOK NA KAGANAPAN",yourActivity:"IYONG AKTIBIDAD",quickActions:"MABILIS NA AKSYON",myEvents:"AKING MGA KAGANAPAN",clubFeedSection:"FEED NG CLUB",dateTBD:"Petsa ay ilalantad pa",live:"LIVE",upcomingLabel:"PAPARATING",joinWaitlist:"Sumali sa waitlist",registerNow:"Mag-register na",viewLeaderboard:"Tingnan ang leaderboard",justNow:"kanina lang",minutesAgo:"{{n}}m nakalipas",hoursAgo:"{{n}}h nakalipas",whsIndex:"WHS Index",bestRound:"Pinakamahusay na Round",grossStrokes:"Kabuuang stroke",avgPerHole:"Average/Butas",strokes:"Mga Suntok",teeBookingsSub:"Mag-book ng slot",score:"Score",scoreSub:"I-record ang round",competeSub:"Mga tournament at liga",clubFeed:"Feed ng Club",clubFeedSub:"Mga post ng miyembro",member:"Miyembro",noFeed:"Wala pang post",golfer:"Golfer",myProfile:"Aking Profile",editProfile:"I-edit ang Profile",displayName:"Pangalan na Ipinapakita",handicapIndex:"Handicap Index",memberSince:"Miyembro mula",changePhoto:"Palitan ang Larawan",changePassword:"Palitan ang Password",tournamentsPlayed:"Mga Tournament na Nilaro",averageScore:"Average na Score",logOut:"Mag-logout",confirmLogout:"Sigurado ka bang gusto mong mag-logout?",myTournaments:"Aking mga Tournament",myLeagues:"Aking mga Liga",myScores:"Aking mga Score",profileUpdated:"Matagumpay na na-update ang profile",worldHandicap:"World Handicap Index",round:"Round",hole:"Butas",putts:"Mga Putt",par:"Par",gross:"Gross",net:"Net",totalScore:"Kabuuang Score",submitScore:"Isumite ang Score",scorecard:"Scorecard",frontNine:"Unang 9",backNine:"Huling 9",total:"Kabuuan"},
  sw:{loading:"Inapakia...",save:"Hifadhi",cancel:"Ghairi",delete:"Futa",edit:"Hariri",confirm:"Thibitisha",close:"Funga",back:"Rudi",next:"Endelea",submit:"Wasilisha",search:"Tafuta",error:"Hitilafu",success:"Mafanikio",noData:"Hakuna data inayopatikana",yes:"Ndiyo",no:"Hapana",ok:"Sawa",status:"Hali",date:"Tarehe",name:"Jina",email:"Barua pepe",phone:"Simu",language:"Lugha",selectLanguage:"Chagua lugha",languageSaved:"Upendeleo wa lugha umehifadhiwa",active:"Amilifu",paid:"Amelipa",unpaid:"Hajalipa",pending:"Inasubiri",draft:"Rasimu",upcoming:"Inakuja",completed:"Imekamilika",cancelled:"Imeghairiwa",logout:"Ondoka",login:"Ingia",register:"Jiandikishe",profile:"Wasifu",settings:"Mipangilio",share:"Shiriki",download:"Pakua",refresh:"Onyesha upya",viewAll:"Angalia yote",home:"Nyumbani",play:"Cheza",compete:"Shindana",club:"Klabu",me:"Mimi",tournaments:"Mashindano",leagues:"Ligi",leaderboard:"Orodha ya Viongozi",scoring:"Alama",notifications:"Arifa",schedule:"Ratiba",teeBookings:"Uhifadhi wa Tee",generalPlay:"Mchezo wa Kawaida",handicap:"Punguzo",guestPasses:"Vibali vya Wageni",caddies:"Wakimbizi wa Mipira",greetMorning:"Habari ya asubuhi",greetAfternoon:"Habari ya mchana",greetEvening:"Habari ya jioni",featuredEvent:"TUKIO MAALUM",yourActivity:"SHUGHULI YAKO",quickActions:"VITENDO VYA HARAKA",myEvents:"MATUKIO YANGU",clubFeedSection:"CHAPISHO LA KLABU",dateTBD:"Tarehe itaamuliwa",live:"MOJA KWA MOJA",upcomingLabel:"INAKUJA",joinWaitlist:"Jiunge na orodha ya kusubiri",registerNow:"Jiandikishe sasa",viewLeaderboard:"Angalia orodha ya viongozi",justNow:"sasa hivi",minutesAgo:"dakika {{n}} zilizopita",hoursAgo:"saa {{n}} zilizopita",whsIndex:"Kielezo cha WHS",bestRound:"Raundi Bora",grossStrokes:"Mapigo ya jumla",avgPerHole:"Wastani/Tundu",strokes:"Mapigo",teeBookingsSub:"Hifadhi nafasi",score:"Alama",scoreSub:"Rekodi raundi",competeSub:"Mashindano na ligi",clubFeed:"Chapisho la klabu",clubFeedSub:"Machapisho ya wanachama",member:"Mwanachama",noFeed:"Hakuna machapisho bado",golfer:"Mchezaji Golf",myProfile:"Wasifu Wangu",editProfile:"Hariri Wasifu",displayName:"Jina la Kuonyeshwa",handicapIndex:"Kielezo cha Punguzo",memberSince:"Mwanachama Tangu",changePhoto:"Badilisha Picha",changePassword:"Badilisha Nywila",tournamentsPlayed:"Mashindano Yaliyochezwa",averageScore:"Alama ya Wastani",logOut:"Ondoka",confirmLogout:"Una uhakika unataka kutoka?",myTournaments:"Mashindano Yangu",myLeagues:"Ligi Zangu",myScores:"Alama Zangu",profileUpdated:"Wasifu umesasishwa",worldHandicap:"Kielezo cha Punguzo cha Dunia",round:"Raundi",hole:"Tundu",putts:"Putti",par:"Par",gross:"Jumla",net:"Wavu",totalScore:"Jumla ya Alama",submitScore:"Wasilisha Alama",scorecard:"Kadi ya Alama",frontNine:"Nane za Mbele",backNine:"Nane za Nyuma",total:"Jumla"},
  af:{loading:"Laai...",save:"Stoor",cancel:"Kanselleer",delete:"Vee uit",edit:"Wysig",confirm:"Bevestig",close:"Sluit",back:"Terug",next:"Volgende",submit:"Indien",search:"Soek",error:"Fout",success:"Sukses",noData:"Geen data beskikbaar nie",yes:"Ja",no:"Nee",ok:"OK",status:"Status",date:"Datum",name:"Naam",email:"E-pos",phone:"Foon",language:"Taal",selectLanguage:"Kies taal",languageSaved:"Taalvoorkeur gestoor",active:"Aktief",paid:"Betaal",unpaid:"Onbetaald",pending:"Hangende",draft:"Konsep",upcoming:"Aanstaande",completed:"Voltooi",cancelled:"Gekanselleer",logout:"Meld af",login:"Meld aan",register:"Registreer",profile:"Profiel",settings:"Instellings",share:"Deel",download:"Laai af",refresh:"Verfris",viewAll:"Sien alles",home:"Tuis",play:"Speel",compete:"Kompeteer",club:"Klub",me:"Ek",tournaments:"Toernooie",leagues:"Ligas",leaderboard:"Ranglys",scoring:"Puntetelling",notifications:"Kennisgewings",schedule:"Skedule",teeBookings:"Tee-besprekings",generalPlay:"Algemene Spel",handicap:"Handicap",guestPasses:"Gaspasse",caddies:"Rondlopers",greetMorning:"Goeie môre",greetAfternoon:"Goeie middag",greetEvening:"Goeie naand",featuredEvent:"UITGESOEKTE GELEENTHEID",yourActivity:"U AKTIWITEIT",quickActions:"VINNIGE AKSIES",myEvents:"MY GELEENTHEDE",clubFeedSection:"KLUB-STROOM",dateTBD:"Datum nog te bepaal",live:"LEWENDIG",upcomingLabel:"AANSTAANDE",joinWaitlist:"Sluit aan by waglys",registerNow:"Registreer nou",viewLeaderboard:"Sien ranglys",justNow:"nou net",minutesAgo:"{{n}}m gelede",hoursAgo:"{{n}}u gelede",whsIndex:"WHS-indeks",bestRound:"Beste ronde",grossStrokes:"Bruto houe",avgPerHole:"Gem / Gat",strokes:"Houe",teeBookingsSub:"Bespreek 'n slot",score:"Telling",scoreSub:"Rekord 'n ronde",competeSub:"Toernooie & ligas",clubFeed:"Klub-stroom",clubFeedSub:"Lidposte",member:"Lid",noFeed:"Geen plasings nog nie",golfer:"Gholfspeler",myProfile:"My Profiel",editProfile:"Wysig Profiel",displayName:"Vertoonnaam",handicapIndex:"Handicap-indeks",memberSince:"Lid Sedert",changePhoto:"Verander Foto",changePassword:"Verander Wagwoord",tournamentsPlayed:"Toernooie Gespeel",averageScore:"Gemiddelde Telling",logOut:"Meld af",confirmLogout:"Is jy seker jy wil afmeld?",myTournaments:"My Toernooie",myLeagues:"My Ligas",myScores:"My Tellings",profileUpdated:"Profiel suksesvol opgedateer",worldHandicap:"Wêreld Handicap-indeks",round:"Ronde",hole:"Gat",putts:"Putte",par:"Par",gross:"Bruto",net:"Netto",totalScore:"Totale Telling",submitScore:"Indien Telling",scorecard:"Telkaart",frontNine:"Voorkant Nege",backNine:"Agterkant Nege",total:"Totaal"},
  am:{loading:"እየጫነ...",save:"አስቀምጥ",cancel:"ሰርዝ",delete:"አጥፋ",edit:"አርትዕ",confirm:"አረጋግጥ",close:"ዝጋ",back:"ተመለስ",next:"ቀጣይ",submit:"አስገባ",search:"ፈልግ",error:"ስህተት",success:"ተሳካ",noData:"ምንም ውሂብ የለም",yes:"አዎ",no:"አይ",ok:"እሺ",status:"ሁኔታ",date:"ቀን",name:"ስም",email:"ኢሜይል",phone:"ስልክ",language:"ቋንቋ",selectLanguage:"ቋንቋ ምረጥ",languageSaved:"የቋንቋ ምርጫ ተቀምጧል",active:"ንቁ",paid:"ተከፍሏል",unpaid:"አልተከፈለም",pending:"በጥበቃ ላይ",draft:"ረቂቅ",upcoming:"ሲቃረብ",completed:"ተጠናቋል",cancelled:"ተሰርዟል",logout:"ውጣ",login:"ግባ",register:"ተመዝገብ",profile:"መገለጫ",settings:"ቅንብሮች",share:"አጋራ",download:"አውርድ",refresh:"አድስ",viewAll:"ሁሉን ይመልከቱ",home:"ዋና ገጽ",play:"ጫወት",compete:"ተወዳደር",club:"ክለብ",me:"እኔ",tournaments:"ውድድሮች",leagues:"ሊጎች",leaderboard:"ደረጃ ሰሌዳ",scoring:"ነጥብ ሰጪ",notifications:"ማሳወቂያዎች",schedule:"መርሃ ግብር",teeBookings:"የቲ ቦታ ማስያዝ",generalPlay:"ጠቅላላ ጨዋታ",handicap:"ሃንዲካፕ",guestPasses:"የእንግዳ ፈቃዶች",caddies:"ካዲዎች",greetMorning:"እንደምን አደሩ",greetAfternoon:"እንደምን ዋሉ",greetEvening:"እንደምን አመሹ",featuredEvent:"ልዩ ክስተት",yourActivity:"የእርስዎ እንቅስቃሴ",quickActions:"ፈጣን ድርጊቶች",myEvents:"ክስተቶቼ",clubFeedSection:"የክለብ ፊድ",dateTBD:"ቀን ይወሰናል",live:"ቀጥታ",upcomingLabel:"ሲቃረብ",joinWaitlist:"የጥበቃ ዝርዝር ይቀላቀሉ",registerNow:"አሁን ይመዝገቡ",viewLeaderboard:"ደረጃ ሰሌዳ ይመልከቱ",justNow:"አሁን",minutesAgo:"{{n}} ደቂቃ በፊት",hoursAgo:"{{n}} ሰዓት በፊት",whsIndex:"WHS ኢንዴክስ",bestRound:"ምርጥ ዙር",grossStrokes:"ጠቅላላ ምቶች",avgPerHole:"አማካይ/ጉድጓድ",strokes:"ምቶች",teeBookingsSub:"ቦታ ያዝ",score:"ነጥብ",scoreSub:"ዙር ይመዝግቡ",competeSub:"ውድድሮች እና ሊጎች",clubFeed:"የክለብ ፊድ",clubFeedSub:"የአባላት ልጥፎች",member:"አባል",noFeed:"ምንም ልጥፍ የለም",golfer:"ጎልፍ ተጫዋች",myProfile:"የእኔ መገለጫ",editProfile:"መገለጫ አርትዕ",displayName:"የማሳያ ስም",handicapIndex:"የሃንዲካፕ ኢንዴክስ",memberSince:"አባል ከሆነ ጀምሮ",changePhoto:"ፎቶ ቀይር",changePassword:"የይለፍ ቃል ቀይር",tournamentsPlayed:"የተደናቀፉ ውድድሮች",averageScore:"አማካይ ነጥብ",logOut:"ውጣ",confirmLogout:"እርግጠኛ ነዎት ለወጣ?",myTournaments:"የእኔ ውድድሮች",myLeagues:"የእኔ ሊጎች",myScores:"የእኔ ነጥቦች",profileUpdated:"መገለጫ ተዘምኗል",worldHandicap:"የዓለም ሃንዲካፕ ኢንዴክስ",round:"ዙር",hole:"ጉድጓድ",putts:"ፑት",par:"ፓር",gross:"ጥቅላላ",net:"ተቀናሽ",totalScore:"ጠቅላላ ነጥብ",submitScore:"ነጥብ አስገባ",scorecard:"የነጥብ ካርድ",frontNine:"የፊት ዘጠኝ",backNine:"የኋላ ዘጠኝ",total:"ጠቅላላ"},
  ha:{loading:"Ana lodi...",save:"Ajiye",cancel:"Soke",delete:"Goge",edit:"Gyara",confirm:"Tabbatar",close:"Rufe",back:"Koma",next:"Na gaba",submit:"Aika",search:"Nema",error:"Kuskure",success:"Nasara",noData:"Babu bayani",yes:"Eh",no:"A'a",ok:"To",status:"Matsayi",date:"Kwanan wata",name:"Suna",email:"Imel",phone:"Waya",language:"Yare",selectLanguage:"Zaɓi yare",languageSaved:"An adana zaɓin yare",active:"Aiki",paid:"An biya",unpaid:"Ba a biya ba",pending:"Jira",draft:"Daftari",upcoming:"Zuwa",completed:"Kammala",cancelled:"An soke",logout:"Fita",login:"Shiga",register:"Yi rajista",profile:"Bayanin kai",settings:"Saiti",share:"Raba",download:"Sauke",refresh:"Sabunta",viewAll:"Duba duka",home:"Gida",play:"Wasa",compete:"Gasa",club:"Kulob",me:"Ni",tournaments:"Gasar",leagues:"Ƙungiyoyi",leaderboard:"Jerin Jagora",scoring:"Ƙididdiga",notifications:"Sanarwa",schedule:"Jadawali",teeBookings:"Keɓancewa na Tee",generalPlay:"Wasan Gaba ɗaya",handicap:"Nakasa",guestPasses:"Izinin Baƙo",caddies:"Masu ɗaukan Jakar Golf",greetMorning:"Barka da safiya",greetAfternoon:"Barka da rana",greetEvening:"Barka da yamma",featuredEvent:"BABBAN TARON",yourActivity:"AYYUKANKA",quickActions:"SAURI AYYUKA",myEvents:"TARONA",clubFeedSection:"LABARUN KULOB",dateTBD:"Ranar za a sanar",live:"LIVE",upcomingLabel:"ZUWA",joinWaitlist:"Shiga jerin jira",registerNow:"Yi rajista yanzu",viewLeaderboard:"Duba jerin jagora",justNow:"yanzu",minutesAgo:"mintoci {{n}} da suka wuce",hoursAgo:"sa'o'i {{n}} da suka wuce",whsIndex:"Lissafin WHS",bestRound:"Mafi Kyaun Zagaye",grossStrokes:"Jimlar Bugawa",avgPerHole:"Matsakaita/Rami",strokes:"Bugawa",teeBookingsSub:"Yi keɓancewa",score:"Maki",scoreSub:"Yi rikodin zagaye",competeSub:"Gasar da ƙungiyoyi",clubFeed:"Labarun kulob",clubFeedSub:"Wallafar mambobi",member:"Memba",noFeed:"Babu wallafe-wallafen",golfer:"Dan wasan Golf",myProfile:"Bayani Na",editProfile:"Gyara Bayani",displayName:"Sunan Nunawa",handicapIndex:"Lissafin Nakasa",memberSince:"Memba Tun",changePhoto:"Canza Hoto",changePassword:"Canza Kalmar Sirri",tournamentsPlayed:"Gasannin da aka Buga",averageScore:"Matsakaicin Maki",logOut:"Fita",confirmLogout:"Shin tabbas kana son fita?",myTournaments:"Gasana Na",myLeagues:"Ƙungiyoyi Na",myScores:"Makin Na",profileUpdated:"An sabunta bayani",worldHandicap:"Lissafin Nakasa na Duniya",round:"Zagaye",hole:"Rami",putts:"Putt",par:"Par",gross:"Jimila",net:"Net",totalScore:"Jimilan Maki",submitScore:"Aika Maki",scorecard:"Katunan Maki",frontNine:"Tara na Farko",backNine:"Tara na Baya",total:"Jimila"},
  zu:{loading:"Iyalayisha...",save:"Gcina",cancel:"Khansela",delete:"Susa",edit:"Hlela",confirm:"Qinisekisa",close:"Vala",back:"Buyela emuva",next:"Okulandelayo",submit:"Thumela",search:"Sesha",error:"Iphutha",success:"Impumelelo",noData:"Ayikho idatha etholakalayo",yes:"Yebo",no:"Cha",ok:"Kulungile",status:"Isimo",date:"Usuku",name:"Igama",email:"I-imeyili",phone:"Ucingo",language:"Ulimi",selectLanguage:"Khetha ulimi",languageSaved:"Ukuphakamisa kolimi kuhlonishiwe",active:"Kusebenza",paid:"Kukhokhiwe",unpaid:"Akukhokhiwe",pending:"Kulindile",draft:"Idrafti",upcoming:"Ezayo",completed:"Kuqediwe",cancelled:"Kukhanseliwe",logout:"Phuma",login:"Ngena",register:"Bhalisa",profile:"Iphrofayili",settings:"Izilungiselelo",share:"Yabelana",download:"Layisha",refresh:"Vuselela",viewAll:"Buka konke",home:"Ikhaya",play:"Dlala",compete:"Xhumana",club:"Ikilabhu",me:"Mina",tournaments:"Amatumamente",leagues:"Amaqembu",leaderboard:"Uhlu Lwabahola",scoring:"Amanani",notifications:"Izaziso",schedule:"Isheduli",teeBookings:"Ukubhukha kwe-Tee",generalPlay:"Umdlalo Jikelele",handicap:"Ihandikepi",guestPasses:"Izimpesheni Zezivakashi",caddies:"Amacaddie",greetMorning:"Sawubona ekuseni",greetAfternoon:"Sawubona emini",greetEvening:"Sawubona ntambama",featuredEvent:"UMCIMBI OVELELE",yourActivity:"IMISEBENZI YAKHO",quickActions:"IZENZO EZISHESHAYO",myEvents:"IMICIMBI YAMI",clubFeedSection:"IZINDABA ZEKILABHU",dateTBD:"Usuku luzomenyezelwa",live:"NGQO",upcomingLabel:"EZAYO",joinWaitlist:"Joyina uhlu lokulinda",registerNow:"Bhalisa manje",viewLeaderboard:"Buka uhlu lwabahola",justNow:"manje nje",minutesAgo:"amamizuzu {{n}} adlule",hoursAgo:"amahora {{n}} adlule",whsIndex:"Inkomba ye-WHS",bestRound:"Umjikelezo Omuhle Kakhulu",grossStrokes:"Amatshayo Ephelele",avgPerHole:"Inani/Imbobo",strokes:"Amatshayo",teeBookingsSub:"Bhukha isikhala",score:"Inani",scoreSub:"Rekhoda umjikelezo",competeSub:"Amatumamente namaqembu",clubFeed:"Izindaba zekilabhu",clubFeedSub:"Amaposi amalungu",member:"Ilungu",noFeed:"Awekho amaposi",golfer:"Umadlali we-Golf",myProfile:"Iphrofayili Yami",editProfile:"Hlela Iphrofayili",displayName:"Igama Lokubonisa",handicapIndex:"Inkomba Yehandikepi",memberSince:"Ilungu Kusukela",changePhoto:"Shintsha Isithombe",changePassword:"Shintsha Iphasiwedi",tournamentsPlayed:"Amatumamente Adlaliwe",averageScore:"Inani Eliyisicelo",logOut:"Phuma",confirmLogout:"Uqinisekile ukuthi ufuna ukuphuma?",myTournaments:"Amatumamente Ami",myLeagues:"Amaqembu Ami",myScores:"Amanani Ami",profileUpdated:"Iphrofayili ibuyekeziwe",worldHandicap:"Inkomba Yehandikepi Yomhlaba",round:"Umjikelezo",hole:"Imbobo",putts:"Amaputti",par:"Ipar",gross:"Igross",net:"Inet",totalScore:"Inani Eliphelele",submitScore:"Thumela Inani",scorecard:"Ikhadi Lamanani",frontNine:"Eyisikhombisa Yangaphambili",backNine:"Eyisikhombisa Yangasemuva",total:"Isamba"},
  yo:{loading:"Ṣiṣe ẹru...",save:"Fi pamọ",cancel:"Fagilé",delete:"Parẹ",edit:"Ṣatunkọ",confirm:"Jẹrisi",close:"Pa",back:"Padà",next:"Tẹle",submit:"Firanṣẹ",search:"Wa",error:"Aṣiṣe",success:"Ìṣeyọrí",noData:"Ko si data ti o wa",yes:"Bẹẹni",no:"Rara",ok:"O dara",status:"Ipo",date:"Ọjọ",name:"Orukọ",email:"Imeeli",phone:"Foonu",language:"Èdè",selectLanguage:"Yan èdè",languageSaved:"Ayanfẹ ede ti wa ni fipamọ",active:"Ṣiṣẹ",paid:"Ti sanwo",unpaid:"Ko sanwo",pending:"Nduro",draft:"Apẹẹrẹ",upcoming:"Ti mbọ",completed:"Ti pari",cancelled:"Ti fagile",logout:"Jade",login:"Wọle",register:"Forukọsilẹ",profile:"Profaili",settings:"Eto",share:"Pin",download:"Gba silẹ",refresh:"Tunṣe",viewAll:"Ri gbogbo",home:"Ile",play:"Dun",compete:"Dije",club:"Ẹgbẹ",me:"Mi",tournaments:"Awọn idije",leagues:"Awọn ẹgbẹ",leaderboard:"Atokọ Awọn Aṣaju",scoring:"Ponti",notifications:"Awọn ifitonileti",schedule:"Akoko-eto",teeBookings:"Iforukọsilẹ Tee",generalPlay:"Ẹkọ Gbogbogbo",handicap:"Handicap",guestPasses:"Àwọn àkọ àlejò",caddies:"Awọn caddie",greetMorning:"E kaaro",greetAfternoon:"E kaasan",greetEvening:"E ku irọlẹ",featuredEvent:"IṢẸLẸ PATAKI",yourActivity:"IṢẸ RẸKUNRINMỌLẸ",quickActions:"IṢẸ KIAKIA",myEvents:"IṢẸLẸ MI",clubFeedSection:"AGBO EGBẸnipọn",dateTBD:"Ọjọ ao mọ",live:"TAARA",upcomingLabel:"TI MBỌ",joinWaitlist:"Darapọ mọ atokọ iduro",registerNow:"Forukọsilẹ bayi",viewLeaderboard:"Wo atokọ awọn aṣaju",justNow:"ṣẹṣẹ",minutesAgo:"iṣẹju {{n}} sẹhin",hoursAgo:"wakati {{n}} sẹhin",whsIndex:"Atọka WHS",bestRound:"Yiyi Ti o Dara Julọ",grossStrokes:"Apapọ Awọn gba",avgPerHole:"Aarin/Iho",strokes:"Awọn gba",teeBookingsSub:"Yà aaye",score:"Ikun",scoreSub:"Gbasilẹ yiyi",competeSub:"Awọn idije ati ẹgbẹ",clubFeed:"Agbo ẹgbẹ",clubFeedSub:"Awọn ifiweranṣẹ ọmọ ẹgbẹ",member:"Ọmọ ẹgbẹ",noFeed:"Ko si ifiweranṣẹ",golfer:"Akọnilopin Golf",myProfile:"Profaili Mi",editProfile:"Ṣatunkọ Profaili",displayName:"Orukọ Ifihan",handicapIndex:"Atọka Handicap",memberSince:"Ọmọ ẹgbẹ lati",changePhoto:"Yipada Fọto",changePassword:"Yipada Ọrọigbaniwọle",tournamentsPlayed:"Awọn Idije ti a Ṣere",averageScore:"Ikun Aarin",logOut:"Jade",confirmLogout:"Ṣe o da ọ loju pe o fẹ jade?",myTournaments:"Awọn Idije Mi",myLeagues:"Awọn Ẹgbẹ Mi",myScores:"Awọn Ikun Mi",profileUpdated:"Profaili ti ni imudojuiwọn",worldHandicap:"Atọka Handicap Agbaye",round:"Yiyi",hole:"Iho",putts:"Putt",par:"Par",gross:"Gbogbo",net:"Net",totalScore:"Ikun Lapapọ",submitScore:"Firanṣẹ Ikun",scorecard:"Kaadi Ikun",frontNine:"Mẹsan Iwaju",backNine:"Mẹsan Ẹhin",total:"Apapọ"},
};

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function buildCommon(t) {
  return {
    loading:t.loading,save:t.save,cancel:t.cancel,delete:t.delete,edit:t.edit,confirm:t.confirm,
    close:t.close,back:t.back,next:t.next,submit:t.submit,search:t.search,error:t.error,
    success:t.success,noData:t.noData,yes:t.yes,no:t.no,ok:t.ok,status:t.status,
    date:t.date,name:t.name,email:t.email,phone:t.phone,language:t.language,
    languages:ALL_LANG_NAMES,
    selectLanguage:t.selectLanguage,languageSaved:t.languageSaved,
    layoutReloadTitle:"Restart Required",
    layoutReloadMessage:"Please close and reopen the app for the layout direction to take effect.",
    active:t.active,paid:t.paid,unpaid:t.unpaid,pending:t.pending,draft:t.draft,
    upcoming:t.upcoming,completed:t.completed,cancelled:t.cancelled,
    logout:t.logout,login:t.login,register:t.register,profile:t.profile,
    settings:t.settings,share:t.share,download:t.download,refresh:t.refresh,viewAll:t.viewAll,
  };
}

function buildNavigation(t) {
  return {
    home:t.home,play:t.play,compete:t.compete,club:t.club,me:t.me,
    tournaments:t.tournaments,leagues:t.leagues,leaderboard:t.leaderboard,
    scoring:t.scoring,profile:t.profile,settings:t.settings,
    notifications:t.notifications,schedule:t.schedule,teeBookings:t.teeBookings,
    generalPlay:t.generalPlay,handicap:t.handicap,guestPasses:t.guestPasses,caddies:t.caddies,
  };
}

function buildHome(t) {
  return {
    greetMorning:t.greetMorning,greetAfternoon:t.greetAfternoon,greetEvening:t.greetEvening,
    featuredEvent:t.featuredEvent,yourActivity:t.yourActivity,quickActions:t.quickActions,
    myEvents:t.myEvents,clubFeedSection:t.clubFeedSection,dateTBD:t.dateTBD,
    live:t.live,upcoming:t.upcomingLabel,joinWaitlist:t.joinWaitlist,
    registerNow:t.registerNow,viewLeaderboard:t.viewLeaderboard,
    leagueLabel:"League · {{format}}",justNow:t.justNow,minutesAgo:t.minutesAgo,
    hoursAgo:t.hoursAgo,handicap:t.handicap,whsIndex:t.whsIndex,bestRound:t.bestRound,
    grossStrokes:t.grossStrokes,avgPerHole:t.avgPerHole,strokes:t.strokes,
    liveEvent:"Live Event — ",nextEvent:"Next Event — ",
    teeBookings:t.teeBookings,teeBookingsSub:t.teeBookingsSub,
    score:t.score,scoreSub:t.scoreSub,compete:t.compete,competeSub:t.competeSub,
    clubFeed:t.clubFeed,clubFeedSub:t.clubFeedSub,member:t.member,noFeed:t.noFeed,golfer:t.golfer,
  };
}

function buildProfile(t) {
  return {
    myProfile:t.myProfile,editProfile:t.editProfile,cancel:t.cancel,
    comingSoon:"Coming Soon",
    editProfileSoon:"Profile editing will be available soon.",
    changePasswordSoon:"Password change will be available soon.",
    displayName:t.displayName,email:t.email,phone:t.phone,
    handicapIndex:t.handicapIndex,memberSince:t.memberSince,
    languagePreference:t.language,selectLanguage:t.selectLanguage,
    changePhoto:t.changePhoto,notifications:t.notifications,
    security:"Security & Privacy",changePassword:t.changePassword,
    tournamentsPlayed:t.tournamentsPlayed,bestRound:t.bestRound,
    averageScore:t.averageScore,logOut:t.logOut,confirmLogout:t.confirmLogout,
    myTournaments:t.myTournaments,myLeagues:t.myLeagues,myScores:t.myScores,
    profileUpdated:t.profileUpdated,emailNotVerified:"Email not verified",
    worldHandicap:t.worldHandicap,fromLastRecord:"from last record",fullHistory:"Full History",
    statsLabels:{tournaments:t.tournaments,avgStrokes:"Avg Strokes",bestRound:t.bestRound,holesPlayed:"Holes Played"},
    loyalty:{section:"Loyalty & Rewards",pointsBalance:"Points Balance",lifetimeEarned:"Lifetime Earned",thisYear:"This Year",availableRewards:"Available Rewards",pts:"pts",needMore:"Need {{count}} more"},
    myGolf:{section:"My Golf",generalPlay:t.generalPlay,generalPlaySub:"Post casual rounds & build handicap",teeBookings:t.teeBookings,teeBookingsSub:"Book a tee time at your club",handicapProfile:"Handicap Profile",handicapProfileSub:"View your WHS Handicap Index history"},
    locker:{section:"My Locker",renewalDate:"Renewal Date",annualFee:"Annual Fee",paymentComplete:"Payment complete",paymentPending:"Payment pending",expired:"Expired",daysLeft:"{{count}}d left",payRenewal:"Pay Renewal Fee",onWaitlist:"On Waitlist",notified:"Notified",joinWaitlist:"Join Waitlist",joining:"Joining…",noAssigned:"No locker assigned.",bay:"Bay {{number}}",lockerTitle:"Locker {{number}}",waitlistJoinedOn:"You joined the waitlist on {{date}}.",lockerAvailable:"A locker is available — contact the club.",willBeNotified:"You will be notified when a locker becomes available."},
    invoices:{section:"My Invoices",payNow:"Pay Now",overdueSince:"Overdue since: ",due:"Due: ",paid:"Paid {{date}}",statuses:{draft:"Draft",sent:"Sent",paid:"Paid",overdue:"Overdue",cancelled:"Cancelled",void:"Void"}},
    repairs:{section:"My Club Repairs",readyForPickup:"Your clubs are ready!",technician:"Technician: {{name}}",expected:"Expected: {{date}}",status:{received:"Received",in_progress:"In Progress",ready_for_pickup:"Ready for Pickup",collected:"Collected"},type:{regrip:"Regrip",reshaft:"Reshaft",loft_lie_adjustment:"Loft/Lie Adj.",cleaning:"Cleaning",other:"Other"}},
    fittingSessions:{section:"My Fitting Sessions",recommendedSpecs:"Recommended Specs",statuses:{booked:"Booked",completed:"Completed",cancelled:"Cancelled"}},
    notificationPreferences:"Notification Preferences",alwaysOn:"Always on",
    notifLabels:{email:"Email Notifications",emailDesc:"Receive tournament updates via email",push:"Push Notifications",pushDesc:"Receive real-time alerts",pushNeedApp:"Install app to enable push notifications",sms:"SMS Notifications",smsDesc:"Receive text reminders",whatsapp:"WhatsApp Notifications",whatsappDesc:"Receive updates via WhatsApp",noPhone:"No phone number on file"},
    languageModal:{title:t.language,description:"Choose your preferred display language.",rtlNote:"Right-to-left layout"},
    scoringHistory:{section:"Scoring History",noHistory:"No tournament history yet",noHistoryDesc:"Register for a tournament and post scores",loadError:"Failed to load scoring history",retry:"Retry",format:"Format",handicap:t.handicap,tee:"Tee",rounds:t.round,noScores:"No scores posted yet",withdraw:"Withdraw from Tournament"},
    withdraw:{title:"Withdraw from Tournament",cancel:t.cancel,confirm:t.confirm,successWithRefund:"You have been withdrawn. A refund request has been raised.",success:"Successfully withdrawn.",message:"Are you sure you want to withdraw from \"{{name}}\"?"},
    rankings:{section:"Rankings & Points",rankingSeries:"Ranking Series",ranked:"Ranked",pts:"pts",events:"Events",wins:"Wins",top3:"Top 3",eventHistory:"Event History",tournament:t.tournaments},
    activeClub:{section:"Active Club"},
    eventRoles:{section:"Event Roles",volunteering:"My Volunteering Assignments"},
    account:{section:"Account",editProfile:t.editProfile,languagePreference:t.language,changePassword:t.changePassword,signOut:t.logOut},
    roundCard:{round:"Round {{n}}",holes_one:"{{count}} hole",holes_other:"{{count}} holes",strokes:t.strokes},
    roundTable:{hole:t.hole,strokes:t.strokes,putts:t.putts,fir:"FIR",gir:"GIR",total:t.total},
    photoOptions:{chooseLibrary:"Choose from Library",takePhoto:"Take Photo",chooseAvatar:"Choose Avatar",removePhoto:"Remove Photo",changeProfilePhoto:"Change Profile Photo",cancel:t.cancel},
    tournaments:{statuses:{upcoming:"UPCOMING",active:"ACTIVE",completed:"COMPLETED",cancelled:"CANCELLED"}},
    errors:{failedLanguageSave:"Failed to save language preference",failedWithdraw:"Failed to withdraw from tournament",networkError:"Network error. Please try again.",photoUpdated:"Profile photo updated.",photoUploadFailed:"Failed to upload profile photo.",avatarSelectFailed:"Failed to select avatar.",avatarPickerDesc:"Pick a golf-themed avatar.",switchClubTitle:"Switch Club",photoRemoveFailed:"Failed to remove photo.",permissionDenied:"Permission denied",permissionLibrary:"Allow photo library access in Settings.",permissionCamera:"Allow camera access in Settings.",waitlistFailed:"Failed to join waitlist",success:t.success,error:t.error},
  };
}

function buildScoring(t) {
  return {
    scoring:t.scoring,score:t.score||"Score",hole:t.hole,strokes:t.strokes,
    putts:t.putts,par:t.par,gross:t.gross,net:t.net,totalScore:t.totalScore,
    submitScore:t.submitScore,scoreSubmitted:"Score submitted successfully",
    round:t.round,frontNine:t.frontNine,backNine:t.backNine,
    total:t.total,scorecard:t.scorecard,handicap:t.handicap,
  };
}

function buildTournamentsMobile(t) {
  return {
    tournaments:t.tournaments,tournament:"Tournament",register:t.register,
    registered:"Registered",checkIn:"Check In",checkedIn:"Checked In",
    leaderboard:t.leaderboard,teeTimes:"Tee Times",results:"Results",
    round:t.round,course:"Course",entryFee:"Entry Fee",format:"Format",
    startDate:"Start Date",status:t.status,noTournaments:"No tournaments available",
  };
}

function buildLeaderboard(t) {
  return {
    header:{leaderboard:t.leaderboard,teeSheet:"Tee Sheet",updates:"Updates",gallery:"Gallery",chat:"Chat",documents:"Documents",tracker:"Tracker"},
    segments:{tournaments:t.tournaments,leagues:t.leagues,rankings:"Rankings"},
    selectTournament:"Select a tournament",
    scoreMode:{gross:t.gross,net:t.net,stableford:"Stableford"},
    bottomNav:{tracker:"Tracker",updates:"Updates",gallery:"Gallery",documents:"Docs",more:"More"},
    stats:{eagles:"Eagles",birdies:"Birdies",pars:"Pars",bogeys:"Bogeys",dblPlus:"Dbl+"},
    overall:"Overall",round:"Round {{n}}",
    viewOptions:{trackerLabel:"Tracker",trackerDesc:"Live hole-by-hole scorecard grid",updatesLabel:"Updates",updatesDesc:"Tournament announcements & alerts",galleryLabel:"Gallery",galleryDesc:"Photos & videos from the event",documentsLabel:"Documents",documentsDesc:"Rules, notices & event documents"},
    gallery:{addCaption:"Add a caption (optional)",addToGallery:"Add to Gallery",chooseSource:"Choose a source",uploadedVideo:"Video uploaded!",uploadedPhoto:"Photo uploaded!",uploadFailed:"Upload failed.",videoTooLong:"Videos must be 60 seconds or shorter.",fileTooLarge:"File must be under 100 MB.",deleteTitle:t.delete,deleteMessage:"Remove this item from the gallery?",deleteButton:t.delete,cancel:t.cancel,couldNotDelete:"Could not delete.",cameraPermission:"Camera permission is required.",mediaPermission:"Media library permission is required."},
    moreViews:"More Views",selectRound:"Select Round",noScoresYet:"No scores recorded yet",
    rank:"Rank",rounds:"rounds",noFlight:"No flight",
    leagues:{signInToView:"Sign in to view your leagues",noLeagues:"No leagues enrolled yet",browseTournaments:"Browse Tournaments"},
    rankings:{title:"World Handicap System",description:"Rankings on KHARAGOLF use the World Handicap System (WHS).",signInToView:"Sign in to view your ranking history",myHistory:"My Handicap History",noHistory:"No ranking history yet\nSubmit rounds to build your index"},
    selectFlight:"Select Flight",roundLabel:"Round",flightLabel:"Flight",
    chooseTournament:"Choose a Tournament",chooseTournamentSubtitle:"Select a tournament above to view the live leaderboard.",
    selectTournamentBtn:"Select Tournament",loadingTracker:"Loading tracker...",
    noScoresTitle:"No Scores Yet",noScoresSubtitle:"The hole-by-hole tracker will populate as scores come in.",
    loadingUpdates:"Loading updates...",noUpdatesTitle:"No Updates Yet",noUpdatesSubtitle:"Tournament announcements will appear here.",
    loadingDocuments:"Loading documents...",noDocumentsTitle:"No Documents",noDocumentsSubtitle:"No documents have been published for this event.",
    loadingGallery:"Loading gallery...",noPhotosTitle:"No Photos Yet",noPhotosSubtitle:"Approved tournament photos will appear here.",
    pending:t.pending,loadingChat:"Loading chat...",signInRequired:"Sign In Required",
    signInToViewChat:"Please sign in to view the tournament chat.",
    chatNotAvailable:"Chat Not Available",chatNotAvailableSubtitle:"The tournament chat room is not enabled yet.",
    noMessagesYet:"No messages yet. Be the first to say something!",
    typeMessage:"Type a message…",logInToSend:"Log in to send messages",
    loadingTeeSheet:"Loading tee sheet...",noTeeTimes:"No Tee Times",noTeeTimesSubtitle:"The draw hasn't been published yet.",
    loadingLeaderboard:"Loading leaderboard...",noScoresLeaderboard:"No Scores Yet",noScoresLeaderboardSubtitle:"Scores appear here as players submit them.",
    chooseTournamentModal:"Choose Tournament",noTournamentsAvailable:"No tournaments available",
    cutLine:"— CUT LINE —",updatedTapPlayer:"Updated {{time}} · Tap a player for scorecard",
    updatedTeamFormat:"Updated {{time}} · Team Format",playersCount:"{{count}} players",
    hcpLabel:"HCP {{hcp}}",teeSheetTimeCol:"TIME",teeSheetHoleCol:"HOLE",teeSheetPlayersCol:"PLAYERS",
  };
}

function buildMatchPlay(t) {
  return {
    title:"Match Play",noBracket:"No bracket available",noBracketSub:"Create a bracket in the admin web app first",
    drawNotGenerated:"Draw not yet generated",match:"Match {{n}}",recordHoleResult:"Record hole result:",
    recordResult:"Record Result",concede:"Concede",notConfigured:"Not configured",
    ryderCupNotConfigured:"Set up the Ryder Cup in the admin web app",
    noMatchesInSession:"No matches in this session",tapHoleToScore:"Tap hole to score:",
    noMatchPlayEvents:"No match play events",noMatchPlaySub:"Active Match Play events will appear here",
    selectTournament:"Select a tournament",bracket:"Bracket",ryderCup:"Ryder Cup",done:"Done",
    allSquare:"All Square",ptsToWin:"pts to win: {{n}}",winsOnePt:"{{team}} wins 1pt",
    halvedHalfPt:"Halved ½pt each",foursomes:"Foursomes",fourBall:"Four-Ball",singles:"Singles",
    finalResult:"Final Result",whoWonMatch:"Who won the match?",whoWonHole:"Who won this hole?",
    concedeMatch:"Concede Match",whichPlayerConcedes:"Which player concedes?",halved:"Halved",
    cancel:t.cancel,hole:"Hole {{n}}",error:t.error,
    failedRecordHole:"Failed to record hole result",failedRecordMatch:"Failed to record match result",
  };
}

function buildFantasy(t) {
  return {
    title:"Fantasy Golf",subtitle:"Draft club players, earn fantasy points based on real tournament scores.",
    noLeagues:"No Fantasy Leagues",noLeaguesSub:"Fantasy leagues will appear here once created.",
    statusSetup:"Setup",statusDrafting:"Drafting",statusLive:"Live",statusFinished:"Finished",
    h2h:"H2H",standings:"Standings",snakeDraft:"Snake",simulDraft:"Simul.",
    draft:"Draft",teamCount:"{{n}} teams",perRoster:"{{n}} per roster",pts:"pts",
    recentPicks:"Recent Picks ({{total}}/{{max}})",availablePlayers:"Available Players",
    draftBtn:"Draft",tabLeaderboard:"Leaderboard",tabDraft:"Draft",
    yourTurn:"It's your turn to pick!",waiting:"Pick {{pick}} of {{max}} — Waiting for {{team}}...",
    hcp:"HCP {{hcp}}",flight:"Flight {{flight}}",searchPlayers:"Search players...",
    draftPlayerTitle:"Draft Player",draftPlayerMsg:"Draft {{name}}?",
    cancel:t.cancel,error:t.error,failedPick:"Failed to make pick",
  };
}

function buildShop(t) {
  return {
    title:"Club Shop",subtitle:"Official club merchandise",tabProducts:"Products",
    tabSaved:"Saved",tabSavedCount:"Saved ({{count}})",tabOrders:"My Orders",
    tabOrdersCount:"My Orders ({{count}})",tabCart:"Cart",tabCartCount:"Cart ({{count}})",
    loadingShop:"Loading shop…",loadingWishlist:"Loading wishlist…",loadingOrders:"Loading orders…",
    shopUnavailable:"Shop Not Available",shopUnavailableSub:"Sign in to access the club shop.",
    noProducts:"No Products Yet",noProductsSub:"Club merchandise will appear here.",
    noSaved:"No Saved Items",noSavedSub:"Tap the heart icon on any product to save it.",
    noOrders:"No Orders Yet",noOrdersSub:"Your orders will appear here after a purchase.",
    reviewPromptTitle:"Review your recent purchase",writeReview:"Write Review",sale:"SALE",
    add:"Add",track:"Track",invoice:"Invoice",requestReturn:"Request Return",
    returnLabel:"Return: {{status}}",reviews_one:"{{count}} review",reviews_other:"{{count}} reviews",
    addToCart:"Add to Cart",buyNow:"Buy Now",outOfStock:"Out of Stock",inStock:"In Stock",
    color:"Color",size:"Size",qty:"Qty",subtotal:"Subtotal",total:t.total,
    checkout:"Checkout",emptyCart:"Your cart is empty",
    emptyCartSub:"Browse products and add them to your cart.",
    placeOrder:"Place Order",processingOrder:"Placing order…",orderSuccess:"Order placed!",
    orderSuccessMsg:"Your order has been placed.",paymentMethod:"Payment Method",
    payOnline:"Pay Online",cod:"Cash on Delivery",deliveryAddress:"Delivery Address",
    addressPlaceholder:"Your delivery address…",submitReturn:"Submit Return Request",
    returnReason:"Reason for return",returnType:"Return type",refund:"Refund",
    exchange:"Exchange",clearCart:"Clear Cart",cancel:t.cancel,close:t.close,
  };
}

function buildOrder(t) {
  return {
    signInToOrder:"Sign in to order food & drinks",selectClub:"Select a club to view the menu",
    title:"Order Food & Drinks",subtitle:"On-course delivery",tabMenu:"Menu",tabMyOrders:"My Orders",
    all:"All",noItems:"No items available",soldOut:"Sold Out",add:"Add",
    viewCart:"View Cart",noOrders:"No orders yet",browseMenu:"Browse Menu",
    orderRef:"Order #{{id}}",hole:"Hole {{n}}",total:"Total: {{amount}}",track:"Track",
    yourCart:"Your Cart",cartEmpty:"Cart is empty",currentHole:"Current Hole (optional)",
    payment:"Payment",specialInstructions:"Special Instructions",placeOrder:"Place Order",
    close:t.close,eachSuffix:"each",holePlaceholder:"e.g. 9",
    allergenPlaceholder:"Allergen info, preferences...",cardAtDelivery:"Card at Delivery",
    chargeToAccount:"Charge to Account",statusReceived:"Order Received",
    statusPreparing:"Preparing",statusReady:"Ready for Pickup!",statusDelivered:"Delivered",
    statusCancelled:"Cancelled",orderReadyTitle:"Your order is ready!",
    orderReadyBody:"Order #{{ref}} is ready for pickup.",
    trackingBanner:"Order #{{id}} — {{status}}",failedToPlaceOrder:"Failed to place order",
    error:t.error,
  };
}

function buildRange(t) {
  return {
    title:"Driving Range",subtitle:"Bay Bookings",tabBook:"Book a Bay",tabBookings:"My Bookings",
    time:"Time",bay:"Bay {{num}}",peak:"Peak",statusFree:"Free",statusBooked:"Booked",
    noSlots:"No slots available",noBookings:"No bookings yet",cancel:t.cancel,
    cancelBtn:t.cancel,keepBtn:"Keep",cancelTitle:"Cancel Booking",
    cancelMessage:"Are you sure you want to cancel this booking?",
    cancelConfirm:"Cancel Booking",cancelledTitle:"Cancelled",
    cancelledMessage:"Your booking has been cancelled.",cancelErrorMessage:"Could not cancel.",
    bookedTitle:"Booked!",bookedMessage:"Bay {{num}} at {{time}} confirmed.",
    bookFailedTitle:"Booking Failed",bookFailedMessage:"Please try again.",
    checkedInTitle:"Checked In!",checkedInMessage:"Booking marked as complete.",
    confirmTitle:"Confirm Booking",confirmBay:"Bay {{num}} at {{time}}",
    includesBuckets_one:"Includes {{count}} bucket ({{balls}} balls)",
    includesBuckets_other:"Includes {{count}} buckets ({{balls}} balls)",bookBay:"Book Bay",
  };
}

function buildTeeBookings(t) {
  return {
    title:"Tee Time Booking",tabBook:"Book a Slot",tabMyBookings:"My Bookings ({{count}})",
    windowBanner:"Booking open up to {{days}} days in advance",locked:"locked",
    noSlots:"No tee slots available",noBookings:"No bookings yet",partySize:"Party size",
    selectSlot:"Select a tee time",membersOnly:"Members only",full:"Full",
    spots_one:"{{count}} spot",spots_other:"{{count}} spots",cancel:t.cancel,keepBtn:"Keep",
    cancelTitle:"Cancel Booking",cancelMessage:"Are you sure you want to cancel this tee time?",
    cancelConfirm:"Cancel Booking",cancelledTitle:"Booking cancelled",
    cancelFailTitle:"Cannot Cancel",cancelFailMessage:"Failed to cancel booking",
    bookFailedTitle:"Booking Failed",bookFailedMessage:"Could not book this slot.",
    bookSuccessTitle:"Booking Confirmed!",bookSuccessMessage:"Tee time at {{time}} on {{date}}.",
    paymentUnavailableTitle:"Native Payment Unavailable",
    paymentUnavailableMessage:"Online payment requires a full app build.",
    payInBrowser:"Pay in Browser",payAtClub:"Pay at Club",
    paySuccessTitle:"Payment Successful!",paySuccessMessage:"Tee time at {{time}} on {{date}} confirmed.",
    payVerifyFailTitle:"Payment Verification Failed",payVerifyFailMessage:"Please contact support.",
    payHeldTitle:"Booking Held",payHeldMessage:"Payment cancelled. Your tee time is reserved but unpaid.",
    payNotStartedTitle:"Booking Held — Payment Not Started",
    payNotStartedMessage:"Could not initialise payment. Your booking is reserved but unpaid.",
    outsideWindowTitle:"Outside Booking Window",
    outsideWindowMessage:"Your membership allows booking up to {{days}} days in advance.",
    groupInfo:"Group of {{size}} · add {{extra}} co-player",
    groupInfo_other:"Group of {{size}} · add {{extra}} co-players",
    searchPlaceholder:"Search by name, email, or member number…",
    guestName:"Guest name",guestEmail:"Email (opt.)",caddieNotes:"Notes for the caddie (optional)",
    payOnline:"Online",payAtCheckin:"Pay at Check-in",bookAndPay:"Book & Pay",
    confirmBooking:"Confirm Booking",booking:"Booking…",estimatedTotal:"Estimated Total",
    memberRate:"Member rate",guestRate:"Guest rate",addGuest:"Add Guest",addMember:"Add Member",
    minPlayers:"min {{min}}",maxPlayers:"max {{max}}",
  };
}

function buildUpdates(t) {
  return {
    title:"Updates",subtitleActivity:"Club activity feed",
    subtitleAnnouncements:"Live tournament announcements",
    tabAnnouncements:"Announcements",tabActivity:"Activity",tabNotices:"Notices",
    rulesTitle:"Rules Assistant",rulesSub:"Ask any golf rules question — AI-powered",
    connectionError:"Connection Error",retry:"Retry",pinned:"Pinned",important:"Important",
    sponsored:"Sponsored",visitSponsor:"Visit Sponsor",readMore:"Read more →",organizer:"Organizer",
    noAnnouncementsTitle:"No Announcements Yet",noAnnouncementsSub:"Tournament announcements will appear here.",
    noActivityTitle:"No Activity Yet",noActivitySub:"Eagles, birdies and achievements will appear here.",
    signInTitle:"Sign In to See Updates",signInSub:"Log in to receive live tournament updates.",
    announcementsCount_one:"{{count}} announcement",announcementsCount_other:"{{count}} announcements",
    feedCount_one:"Last 7 days · {{count}} event",feedCount_other:"Last 7 days · {{count}} events",
    noticesCount_one:"{{count}} notice",noticesCount_other:"{{count}} notices",
    couldNotLoad:"Could not load announcements.",searchNotices:"Search notices…",
    noResultsFound:"No results found",noNoticesYet:"No Notices Yet",
    noNoticesSub:"Club notices will appear here.",noResultsSub:"Try a different search term.",
    typeLabels:{general:"General",delay:"Delay",rule:"Rule",results:"Results"},
    justNow:"just now",minutesAgo:"{{count}}m ago",hoursAgo:"{{count}}h ago",daysAgo:"{{count}}d ago",
  };
}

// Web-specific builders
function buildWebCommon(t) {
  return {...buildCommon(t),inactive:"Inactive",enabled:"Enabled",disabled:"Disabled",
    refunded:"Refunded",active_status:t.active,suspended:"Suspended",
    today:"Today",yesterday:"Yesterday",thisWeek:"This Week",thisMonth:"This Month",
    all:"All",none:"None",perPage:"Per page",page:"Page",of:"of",rows:"rows",
    copyLink:"Copy Link",copied:"Copied!",upload:"Upload",print:"Print",preview:"Preview",points:"Points"};
}

function buildWebNavigation(t) {
  return {...buildNavigation(t),
    dashboard:"Dashboard",players:"Players",members:"Members",courses:"Courses",
    analytics:"Analytics",payments:"Payments",messages:"Messages",shop:"Shop",
    portal:"Player Portal",results:"Results",teeSheet:"Tee Sheet",
    noticeboard:"Noticeboard",feedback:"Feedback",superAdmin:"Super Admin",
    commerce:"Commerce",accounting:"Accounting",sponsors:"Sponsors",governance:"Governance",
    feed:"Feed",rankings:"Rankings",stats:"Statistics",switchClub:"Switch Club",
    activeClub:"Active Club",signOut:t.logout,organization:"Organization",
    expandSidebar:"Expand sidebar",collapseSidebar:"Collapse sidebar",allClubs:"All Clubs",
    sections:{overview:"Overview",core:"Overview",play:"Play",competitions:"Competitions",handicap:"Handicap",members:"Members",commerce:"Commerce",fnb:"Food & Beverage",facilities:"Facilities",communication:"Communication",business:"Business",events:"Events & Education",admin:"Administration",system:"System"},
    items:{dashboard:"Dashboard",teeBookings:"Tee Bookings",teeSheetSettings:"Tee Sheet Settings",drivingRange:"Driving Range",generalPlay:"General Play",teeTimeMarketplace:"Tee Time Marketplace",courses:"Courses",paceOfPlay:"Pace of Play",tournaments:"Tournaments",leagues:"Leagues",fantasyGolf:"Fantasy Golf",clubChampionship:"Club Championship",interclub:"Interclub",juniorGolf:"Junior Golf",myHandicap:"My Handicap",annualHIReview:"Annual H.I. Review",hcpCommittee:"HCP Committee",clubMembers:"Club Members",players:"Players",waitlist:"Waitlist",guestPasses:"Guest Passes",posTerminal:"POS Terminal",shop:"Shop",giftCards:"Gift Cards",payments:"Payments",duesBilling:"Dues & Billing",commissions:"Commissions",consignment:"Consignment",loyaltyRewards:"Loyalty & Rewards",gstInvoices:"GST Invoices",commerceAnalytics:"Commerce Analytics",promotions:"Promotions",fbOrders:"F&B Orders",fbFulfillment:"F&B Fulfillment",cartFleet:"Cart Fleet",caddies:"Caddies",rentals:"Rentals",lockers:"Lockers",clubRepair:"Club Repair",courseMaintenance:"Course Maintenance",noticeBoard:"Notice Board",clubFeed:"Club Feed",messages:"Messages",surveysFeedback:"Surveys & Feedback",marketing:"Marketing",analytics:"Analytics",biDashboard:"BI Dashboard",sponsors:"Sponsors",vendorOperators:"Vendor Operators",procurement:"Procurement",inventory:"Inventory",accountingFinance:"Accounting & Finance",rankings:"Rankings",eventsFunctions:"Events & Functions",golfTrips:"Golf Trips",scheduling:"Scheduling",eventStaffing:"Event Staffing",lessons:"Lessons",proDashboard:"Pro Dashboard",lessonsAdmin:"Lessons Admin",settings:"Settings",webhooks:"Webhooks",governance:"Governance",tvDisplay:"TV Display",superAdmin:"Super Admin"}};
}

function buildWebProfile(t) {
  return {...buildProfile(t),username:"Username",profilePicture:"Profile Picture",
    removePhoto:"Remove Photo",role:"Role",organization:"Organization",
    saveLanguage:t.save+" "+t.language,currentPassword:"Current Password",
    newPassword:"New Password",confirmPassword:"Confirm Password",
    passwordUpdated:"Password updated successfully",myStats:"My Statistics"};
}

function buildWebTournaments(t) {
  return {
    tournaments:t.tournaments,tournament:"Tournament",newTournament:"New Tournament",
    createTournament:"Create Tournament",editTournament:"Edit Tournament",
    tournamentName:"Tournament Name",tournamentFormat:"Format",startDate:"Start Date",
    endDate:"End Date",entryFee:"Entry Fee",maxPlayers:"Max Players",
    registeredPlayers:"Registered Players",status:t.status,rounds:"Rounds",
    round:t.round,course:"Course",description:"Description",register:t.register,
    registered:"Registered",checkIn:"Check In",checkedIn:"Checked In",withdraw:"Withdraw",
    leaderboard:t.leaderboard,scorecards:"Scorecards",teeTimes:"Tee Times",
    pairings:"Pairings",results:"Results",publish:"Publish",unpublish:"Unpublish",
    formats:{stroke_play:"Stroke Play",net_stroke:"Net Stroke",best_ball:"Best Ball",scramble:"Scramble",skins:"Skins",match_play:"Match Play",stableford:"Stableford",shamble:"Shamble"},
    statuses:{draft:t.draft,upcoming:t.upcoming,active:t.active,completed:t.completed,cancelled:t.cancelled,suspended:"Suspended"},
    registrationDeadline:"Registration Deadline",handicapAllowance:"Handicap Allowance",
    memberEntryFee:"Member Entry Fee",publicTournament:"Public Tournament",
    membersOnly:"Members Only",noTournaments:"No tournaments found",
    deleteTournament:"Delete Tournament",confirmDelete:"Are you sure you want to delete this tournament?",
  };
}

function buildWebLeagues(t) {
  return {
    leagues:t.leagues,league:"League",newLeague:"New League",createLeague:"Create League",
    editLeague:"Edit League",leagueName:"League Name",leagueFormat:"Format",
    seasonStart:"Season Start",seasonEnd:"Season End",entryFee:"Entry Fee",
    maxMembers:"Max Members",members:"Members",status:t.status,standings:"Standings",
    position:"Position",points:"Points",rounds:"Rounds Played",wins:"Wins",draws:"Draws",
    losses:"Losses",
    formats:{stableford:"Stableford",stroke_play:"Stroke Play",net_stroke:"Net Stroke",match_play:"Match Play"},
    noLeagues:"No leagues found",join:"Join League",leave:"Leave League",
  };
}

function buildWebScoring(t) {
  return {...buildScoring(t),scores:"Scores",holes:"Holes",birdie:"Birdie",eagle:"Eagle",
    bogey:"Bogey",doubleBogey:"Double Bogey",tripleBogey:"Triple Bogey",
    albatross:"Albatross",holeInOne:"Hole in One",netScore:"Net Score",grossScore:"Gross Score",
    editScore:"Edit Score",verifyScore:"Verify Score",scoreVerified:"Score Verified",
    scoreRejected:"Score Rejected",markerSignature:"Marker Signature",
    roundComplete:"Round Complete",fairwayHit:"Fairway Hit",girHit:"GIR"};
}

function buildWebPublicBook(t) {
  return {
    title:"Tee Time Booking",loading:t.loading,unavailable:"Unavailable",
    noSlots:"No Open Tee Times",noSlotsSub:"Check back soon — new slots are added regularly.",
    noSlotsDate:"No tee times on this date.",live:"LIVE",full:"Full",
    spotsLeft_one:"{{count}} spot left",spotsLeft_other:"{{count}} spots left",
    hole:"Hole {{n}}",players:"Players",notes:"Notes",notesPlaceholder:"Optional note…",
    total:"Total ({{players}} × {{price}})",book:"Book",close:t.close,
    confirmFree:"Confirm Free Booking",pay:"Pay {{price}} × {{players}}",
    processing:"Processing…",bookingConfirmed:"Booking Confirmed!",
    bookingCancelled:"Booking Cancelled",
    bookingRef:"Booking #{{id}} — show at the pro shop",
    addToCalendar:"Add to Calendar (.ics)",cancelBooking:"Cancel this booking",
    cancelling:"Cancelling…",
    cancelledMsg:"Your booking has been cancelled. If you paid, a refund has been initiated.",
    signInPrompt:"Please <0>sign in to your player portal</0> to book a tee time.",
    footer:"All times shown in local time · Cancellation subject to club policy",
    poweredBy:"Powered by",
    errors:{cancellationFailed:"Cancellation failed",networkError:"Network error. Please try again.",bookingFailed:"Booking failed",paymentGatewayNotLoaded:"Payment gateway not loaded.",paymentVerificationFailed:"Payment verification failed",notAvailable:"Tee time booking is not available for this organisation.",failedToLoad:"Failed to load tee times."},
  };
}

function buildWebAdmin(t) {
  return {
    settings:"Settings",settingsDesc:"Manage your club profile, branding, and account configuration.",
    sections:{clubProfile:"Club Profile",contactInfo:"Contact Info",branding:"Branding",language:t.language,customDomain:"Custom Domain",commChannels:"Comm Channels",ghinWhs:"GHIN / WHS",shop:"Shop",subscription:"Subscription",dangerZone:"Danger Zone"},
    clubName:"Club Name",description:"Description",slugLabel:"Slug (URL identifier)",
    slugNote:"Slug cannot be changed once set. Contact support to update.",
    saveProfile:"Save Profile",saving:"Saving…",contactHeading:"Club Contact Information",
    contactNote:"These details appear on public pages.",contactEmail:"Contact Email",
    contactPhone:"Contact Phone",clubAddress:"Club Address",clubWebsite:"Club Website",
    saveContact:"Save Contact Info",clubLogo:"Club Logo",
    logoNote:"Upload a logo file (PNG, JPG, SVG, or WebP) or paste a public URL.",
    uploadFile:"Upload file",uploading:"Uploading…",applyBranding:"Apply Branding",
    active:t.active,inactive:"Inactive",customSubdomain:"Custom Subdomain",
    customSubdomainDesc:"Use your own domain for the player portal.",
    cnameSetup:"CNAME Setup Instructions",cnameStep1:"Log in to your domain registrar",
    cnameStep2:"Go to DNS settings for your domain",
    cnameStep3:"Add a CNAME record pointing your subdomain to:",
    dnsPropagation:"DNS propagation may take up to 48 hours.",saveDomain:"Save Domain",
    channels:{email:"Email",push:"Push Notifications",sms:"SMS",whatsapp:"WhatsApp",commChannels:"Communication Channels",description:"These are the messaging channels available for player notifications.",via:"via",loadingStatus:"Loading channel status…"},
    ghin:{apiKey:"GHIN API Key",apiKeyPlaceholder:"Your GHIN API key",username:"GHIN Username (Email)",password:"GHIN Software Password",passwordPlaceholder:"GHIN software password",updateCreds:"Update Credentials",setCreds:"Set Credentials",noOrgCreds:"No org-level credentials set",noEnvCreds:"No server-level credentials configured",integrationTitle:"GHIN / WHS Integration",integrationDesc:"Configure your GHIN API credentials for automatic WHS score posting.",credentialStatus:"Credential Status",orgCredsConfigured:"Org-level GHIN credentials configured (encrypted)",globalCredsAvailable:"Global server-level credentials available (env fallback)",noGhinConfigured:"No GHIN credentials configured.",encKeyMissing:"Encryption key not configured",encKeyDesc:"The ENCRYPTION_SECRET environment variable is not set.",encKeyFallback:" Server-level credentials are available as a fallback.",credDesc:"Enter your GHIN software credentials.",saveCredentials:"Save Credentials",removeCredentials:"Remove Credentials",removing:"Removing…",connectionTest:"Connection Test",connectionTestDesc:"Verify your stored GHIN credentials.",testing:"Testing…",testConnection:"Test Connection",playersWithGhin:"{{count}} player has a GHIN number on file.",playersWithGhin_plural:"{{count}} players have a GHIN number on file."},
    trackingPlaceholder:"Enter tracking #",
    shop:{productName:"Product Name",basePrice:"Base (Cost) Price",sellingPrice:"Selling Price",deactivateConfirm:"Deactivate this product?",totalRevenue:"Total Revenue",ordersThisMonth:"Orders This Month",pendingFulfillment:"Pending Fulfillment",selfManaged:"Self-managed",shiprocketDesc:"India-first shipping via Shiprocket.",products:"Products",addProduct:"Add Product",loadingProducts:"Loading products…"},
  };
}

function buildWebPortal(t) {
  return {
    signIn:"Sign In",signInDesc:"Access your player portal",emailAddress:"Email Address",
    password:"Password",forgotPassword:"Forgot Password?",signingIn:"Signing in…",
    noAccount:"Don't have an account?",signUp:"Sign up",createAccount:"Create Account",
    resetPassword:"Reset Password",resetLinkSent:"Reset link sent!",
    resetLinkSentDesc:"If {{email}} is registered, you'll receive a reset link within a few minutes. It expires in 1 hour.",
    sendResetLink:"Send Reset Link",emailNotVerified:"Your email is not verified.",
    adminPreviewBanner:"You're previewing the Player Portal as an administrator.",
    goToAdmin:"Go to Admin →",dismiss:"Dismiss",profilePhoto:"Profile Photo",
    uploadPhoto:"Upload Photo",chooseAvatar:"Choose Avatar",
    dragToReposition:"Drag to reposition · Scroll to zoom",
    clickToSelectOrDrop:"Click to select or drag & drop",
    fileFormatNote:"PNG, JPEG or WebP · Max 10 MB",
    selectGolfAvatar:"Select a golf-themed avatar.",chooseDifferent:"Choose Different",
    uploadAndSave:"Upload & Save",handicapTrend:"Handicap Trend",
    coursePerformance:"Course Performance",course:"Course",avgScore:"Avg Score",
    noRankingEntries:"No ranking entries found.",
    youllAppearHereRanked:"You'll appear here once you participate in a ranked event.",
    eventHistory:"Event History",position:"Position",
    leagueAdminNote:"When an admin adds you to a league, it will appear here.",
    roundsPlayedCount:"{{count}} rounds played",loadingTiers:"Loading available tiers…",
    nextBilling:"Next Billing",renewalDate:"Renewal Date",failedPayments:"Failed Payments",
    paymentPastDue:"Your subscription payment is past due.",
    cancelAnytime:"You can cancel your subscription at any time.",
    cancelSubscription:"Cancel Subscription",
    subscriptionCancelledContact:"Your subscription has been cancelled.",
    noOrdersYet:"No orders yet.",visitShopBrowse:"Visit the club shop to browse merchandise.",
    goToShop:"Go to Shop",trackShipment:"Track Shipment",wishlistEmpty:"Your wishlist is empty.",
    saveProductsNote:"Save products from the shop.",browseShop:"Browse Shop",
    sizeLabel:"Size: {{size}}",qtyLabel:"Qty: {{count}}",rounds:"Rounds",best:"Best",
  };
}

function buildWebRegister(t) {
  return {
    loading:"LOADING...",registrationUnavailable:"Registration Unavailable",
    addedToWaitlist:"Added to Waitlist!",waitlistPosition:"Your position on the waitlist",
    waitlistAutoReg:"You'll be automatically registered if a spot opens up.",
    youreRegistered:"You're Registered!",entryFeeRequired:"Entry Fee Required",
    payWithRazorpay:"Pay with Razorpay",paymentSuccessful:"Payment Successful!",
    tournamentBegins:"Tournament begins {{date}}",datesToConfirm:"Dates to be confirmed.",
    checkEmail:"Check your email for confirmation details.",addToCalendar:"Add to Calendar",
    additionalDetails:"Additional Registration Details",
    completeAdditionalInfo:"Please complete the following information.",
    submitDetails:"Submit Details",submitting:"Submitting…",
    detailsSubmitted:"Registration details submitted!",
    allDone:"All done — we look forward to seeing you.",
    eventMerchandise:"Event Merchandise",reserveItemsNow:"Reserve items now.",
    reserving:"Reserving...",reserveSelected:"Reserve Selected Items",
    joinWaitlist:"Join the Waitlist",playerRegistration:"Player Registration",
    firstName:"First Name",lastName:"Last Name",emailAddress:"Email Address",
    phoneNumber:"Phone Number",handicapIndex:t.handicapIndex,teeBox:"Tee Box",
    teeBoxes:{black:"Black (Championship)",blue:"Blue (Men's+)",white:"White (Men's)",gold:"Gold (Senior/Junior)",red:"Red (Ladies')"},
    joiningWaitlist:"Joining Waitlist...",registering:"Registering...",
    joinWaitlistBtn:"Join Waitlist",registerForTournament:"Register for Tournament",
    agreeToRules:"By registering you agree to the tournament rules.",
    membersOnly:"Members Only",guestFee:"Guest Fee",memberFee:"Member Fee",
    entryFee:"Entry Fee",players:"Players",
    membersOnlyNote:"This tournament is open to club members only.",
    tournamentFullWaitlist:"This tournament is full — you can join the waitlist.",
    tournamentFullMembersWaitlist:"This tournament is full — join the waitlist if you are a member.",
    availableAtProShop:"Available at the Pro Shop on event day.",
    eventMerchandiseAvailable:"Event Merchandise Available",
    selectOption:"Select an option…",chooseFile:"Choose file…",
    errors:{requiredFields:"First name, last name, and email are required",membersOnly:"This tournament is open to club members only.",registrationFailed:"Registration failed",anError:"An error occurred. Please try again.",isRequired:"\"{{label}}\" is required",failedToSubmit:"Failed to submit. Please try again.",couldNotCreateOrder:"Could not create payment order.",paymentVerificationFailed:"Payment verification failed.",paymentError:"Payment error.",tournamentNotFound:"Tournament not found",failedToLoad:"Failed to load tournament"},
    publicForm:{unableToLoad:"Unable to load registration form.",contactOrganiser:"Please contact the event organiser.",submitted:"Registration Submitted!",submittedDesc:"Your additional details have been recorded.",noAdditionalInfo:"No additional registration information required.",registrationDetails:"Registration Details",completeToFinish:"Please complete the following to finish your registration.",fileUploadNote:"Files will be submitted with your form.",acceptTerms:"I accept the terms and conditions.",submissionFailed:"Submission failed",submitRegistration:"Submit Registration"},
  };
}

function buildWebDashboard(t) {
  return {
    title:"Organization Overview",subtitle:"Analytics and active events for {{name}}",
    settingUp:"Setting Up Your Account",settingUpDesc:"Your profile is being linked to an organization.",
    refreshNow:"Refresh Now",signOut:t.logout,retrying:"Retrying automatically…",
    noDataYet:"No data yet",noTournamentsYet:"No tournaments yet",
    noActiveTournaments:"No active tournaments",
    noActiveTournamentsDesc:"Start a tournament to see live scoring here.",
    createTournament:"Create Tournament",viewAll:"View All",view:"View",live:"Live",tbd:"TBD",
    tabs:{overview:"Overview",clubStats:"Club Stats",analytics:"Analytics"},
    stats:{activeEvents:"Active Events",totalPlayers:"Total Players",roundsPlayed:"Rounds Played",totalEvents:"Total Events",tournaments:t.tournaments,players:"Players",roundsCompleted:"Rounds Completed",retentionRate:"Retention Rate",totalRounds:"Total Rounds",scoreRecords:"Total Score Records",scoreRecordsDesc:"Across all tournaments & rounds",retentionDesc:"Players who competed in 2+ events"},
    leaderboards:{bestScoringAverage:"Best Scoring Average",mostBirdies:"Most Birdies",mostEagles:"Most Eagles",mostConsistent:"Most Consistent (Rounds)",valueLabels:{avg:"avg",birdies:"birdies",eagles:"eagles",rounds:"rounds"}},
    charts:{formatPopularity:"Format Popularity",eventParticipationLast12:"Event Participation (Last 12)",eventParticipationLast8:"Event Participation (Last 8)",monthlyGrowth:"Monthly Player Growth (12 months)",revenueTrend:"Revenue Trend (Entry Fees)",participationRetention:"Participation & Retention",playerRetentionRate:"Player Retention Rate",seriesRegistered:"Registered",seriesPaid:"Paid",seriesPlayers:"Players",seriesNewPlayers:"New Players",seriesRevenue:"Revenue",seriesTournaments:"Tournaments"},
    quickLinks:{title:"Quick Links",allTournaments:"All Tournaments",courses:"Courses",clubStats:"Club Stats"},
    liveEvents:"Live & Upcoming Events",
  };
}

// ─── GENERATE ALL FILES ───────────────────────────────────────────────────────

const mobileBuilders = {
  common: buildCommon,
  navigation: buildNavigation,
  home: buildHome,
  profile: buildProfile,
  scoring: buildScoring,
  tournaments: buildTournamentsMobile,
  leaderboard: buildLeaderboard,
  matchPlay: buildMatchPlay,
  fantasy: buildFantasy,
  shop: buildShop,
  order: buildOrder,
  teeBookings: buildTeeBookings,
  range: buildRange,
  updates: buildUpdates,
};

const webBuilders = {
  common: buildWebCommon,
  navigation: buildWebNavigation,
  dashboard: buildWebDashboard,
  profile: buildWebProfile,
  scoring: buildWebScoring,
  tournaments: buildWebTournaments,
  leagues: buildWebLeagues,
  portal: buildWebPortal,
  register: buildWebRegister,
  publicBook: buildWebPublicBook,
  admin: buildWebAdmin,
};

let mobileCount = 0, webCount = 0;

for (const [code, t] of Object.entries(LANGS)) {
  for (const [ns, builder] of Object.entries(mobileBuilders)) {
    writeJson(path.join(MOBILE_BASE, code, `${ns}.json`), builder(t));
    mobileCount++;
  }
  for (const [ns, builder] of Object.entries(webBuilders)) {
    writeJson(path.join(WEB_BASE, code, `${ns}.json`), builder(t));
    webCount++;
  }
}

const totalLangs = Object.keys(LANGS).length;
console.log(`✓ Generated ${mobileCount} mobile files (${totalLangs} languages × ${Object.keys(mobileBuilders).length} namespaces)`);
console.log(`✓ Generated ${webCount} web files (${totalLangs} languages × ${Object.keys(webBuilders).length} namespaces)`);
console.log(`✓ Languages: ${Object.keys(LANGS).join(", ")}`);
