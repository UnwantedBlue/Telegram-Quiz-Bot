// Pay-wall FOUNDATION (the "#" items of the spec): one place that says what is free and what is premium.
// Premium is bought with Telegram Stars (no payment provider needed) or granted by the owner with /grant.
import { nowSec } from "./engine.js";

export const PREMIUM_DAYS = 30;
export const FREE = { quizzes: 50, folders: 10, timedQuestions: 10, exam: false, encrypted: false, paid: false, ads: true };
export const PREMIUM = { quizzes: 300, folders: 100, timedQuestions: 500, exam: true, encrypted: true, paid: true, ads: false };

export const isOwner = (env, uid) => !!env.OWNER_ID && String(uid) === String(env.OWNER_ID);

export async function isPremium(env, db, uid) {
  return isOwner(env, uid) || (await db.premiumUntil(uid)) > nowSec();
}
export async function limitsFor(env, db, uid) {
  return (await isPremium(env, db, uid)) ? PREMIUM : FREE;
}
export const starsPrice = (env) => Math.max(1, parseInt(env.PREMIUM_STARS || "100", 10) || 100);

export const PREMIUM_PERKS = [
  `📁 Up to ${PREMIUM.folders} folders (free: ${FREE.folders})`,
  `📚 Up to ${PREMIUM.quizzes} quizzes (free: ${FREE.quizzes})`,
  `⏱ A different time for up to ${PREMIUM.timedQuestions} questions per quiz (free: ${FREE.timedQuestions})`,
  "🔐 Password-encrypted backups",
  "🎓 Exam mode: no result or review for the taker, everything goes to you",
  "💰 Paid quizzes (Telegram Stars)",
  "🚫 No sponsored messages",
];
