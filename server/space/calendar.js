/**
 * 日历
 * 翻一下就知道今天几号星期几，有没有节日快到了
 */

// 固定节日（可自行添加个人纪念日）
const HOLIDAYS = [
  { month: 1, day: 1, name: '元旦' },
  { month: 2, day: 14, name: '情人节' },
  { month: 4, day: 1, name: '愚人节' },
  { month: 5, day: 1, name: '劳动节' },
  { month: 6, day: 1, name: '儿童节' },
  { month: 9, day: 10, name: '教师节' },
  { month: 10, day: 1, name: '国庆节' },
  { month: 12, day: 24, name: '平安夜' },
  { month: 12, day: 25, name: '圣诞节' },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function getCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekday = WEEKDAYS[now.getDay()];
  const hour = now.getHours();
  const minute = now.getMinutes().toString().padStart(2, '0');

  let result = `${year}年${month}月${day}日 星期${weekday} ${hour}:${minute}`;

  // 检查今天是不是节日
  const todayHoliday = HOLIDAYS.find(h => h.month === month && h.day === day);
  if (todayHoliday) {
    result += `\n今天是${todayHoliday.name}`;
  }

  // 检查未来两天内有没有节日
  const upcoming = [];
  for (let offset = 1; offset <= 2; offset++) {
    const future = new Date(now);
    future.setDate(future.getDate() + offset);
    const fMonth = future.getMonth() + 1;
    const fDay = future.getDate();
    const holiday = HOLIDAYS.find(h => h.month === fMonth && h.day === fDay);
    if (holiday) {
      upcoming.push(`${offset === 1 ? '明天' : '后天'}是${holiday.name}`);
    }
  }
  if (upcoming.length > 0) {
    result += '\n' + upcoming.join('\n');
  }

  return result;
}

export { getCalendar, HOLIDAYS };
