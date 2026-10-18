/**
 * Court Booking & Status Commands
 * Handles court schedule queries, availability checks, direct bookings,
 * cancellations, and booking notifications for SCVCC.
 */

const scvcc = require('../scvcc');
const groupsConfig = require('../groupsConfig');
const messageHistory = require('../messageHistory');

/**
 * Sends court booking confirmations and cancellation messages to LIDs specified
 * in bookingNotifications configuration for the group.
 */
async function sendBookingNotifications(sock, chatId, message) {
  if (!sock || !chatId || !message) return;
  try {
    const recipients = groupsConfig.getBookingNotifications(chatId);
    if (!recipients || recipients.length === 0) return;

    // Do not include information about admin override in notification messages
    const cleanMessage = message
      .replace(/\s*\*\((?:Admin\s+)?Override\)\*/gi, '')
      .replace(/\s*\((?:Admin\s+)?Override\)/gi, '');

    for (const recipient of recipients) {
      if (chatId.toLowerCase() === recipient.toLowerCase()) continue;

      try {
        messageHistory.recordMessage(recipient, 'tenbot', cleanMessage, Date.now(), true);
        await sock.sendMessage(recipient, { text: cleanMessage });
        console.log(`[notifications] Sent booking notification to ${recipient} for group ${chatId}`);
      } catch (err) {
        console.error(`[notifications] Failed to send booking notification to ${recipient}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[notifications] Error in sendBookingNotifications:', err.message);
  }
}

/**
 * Handles SCVCC court status and booking commands:
 * !courtbookings, !courts, !bookcourt, !cancelcourt, !mybookings
 */
async function handleCourtCommand(sock, text, chatId, sender) {
  const lower = text.toLowerCase();

  // !courtbookings, !bookings, !courtreservations, !reservations, !courtschedule
  if (
    lower === '!courtbookings' || lower.startsWith('!courtbookings ') ||
    lower === '!bookings' || lower.startsWith('!bookings ') ||
    lower === '!courtreservations' || lower.startsWith('!courtreservations ') ||
    lower === '!reservations' || lower.startsWith('!reservations ') ||
    lower === '!courtschedule' || lower.startsWith('!courtschedule ')
  ) {
    const parsed = scvcc.parseBookingsCommand(text);
    const res = await scvcc.getCourtBookings({ ...parsed, chatId });
    return res?.message || 'Could not retrieve court bookings.';
  }

  // !courts, !courtstatus, !courtavailability
  if (
    lower === '!courts' || lower.startsWith('!courts ') ||
    lower === '!courtstatus' || lower.startsWith('!courtstatus ') ||
    lower === '!courtavailability' || lower.startsWith('!courtavailability ')
  ) {
    const parsed = scvcc.parseCourtsCommand(text);
    const res = await scvcc.checkCourtAvailability({ ...parsed, chatId });
    return res?.message || 'Could not retrieve court status.';
  }

  // !bookcourt, !reservecourt
  if (lower.startsWith('!bookcourt') || lower.startsWith('!reservecourt')) {
    const parsed = scvcc.parseBookCourtCommand(text);
    if (!parsed) {
      return '⚠️ Please provide date, time, and optional court for booking, e.g. `!bookcourt Court 2 9am tomorrow`.';
    }
    const isSingles = parsed.partySize === 'Singles';
    const maxNeeded = isSingles ? 2 : 4;
    // If full roster of players is already specified (4 for doubles, 2 for singles),
    // let Player 1 come from the list rather than inserting the sender.
    const defaultRequester = (parsed.players && parsed.players.length >= maxNeeded) ? null : sender;

    const res = await scvcc.bookCourt({
      ...parsed,
      requester: parsed.requester || defaultRequester,
      requestedBy: sender,
      chatId
    });
    if (res && res.success && res.message) {
      await sendBookingNotifications(sock, chatId, res.message);
    }
    return res?.message || 'Could not complete court booking.';
  }

  // !cancelcourt, !cancelreservation
  const cancelCourtMatch = text.match(/(?:!(?:cancelcourt|cancelreservation)|\b(?:cancel|delete)\s+(?:court\s+)?(?:reservation|booking)\b)\s+([A-Za-z0-9_]+)/i);
  if (cancelCourtMatch) {
    const res = await scvcc.cancelCourtReservation(cancelCourtMatch[1], chatId);
    if (res && res.success && res.message) {
      await sendBookingNotifications(sock, chatId, res.message);
    }
    return res?.message || 'Could not cancel reservation.';
  }

  // !mybookings, !myreservations, !mycourts
  if (lower === '!mybookings' || lower === '!myreservations' || lower === '!mycourts') {
    const res = await scvcc.getMyReservations(chatId);
    return res?.message || 'Could not retrieve member reservations.';
  }

  return null;
}

/**
 * Handles LLM tool calls for court bookings and availability:
 * get_court_bookings, check_court_availability, book_court, cancel_court_reservation, get_my_court_bookings
 */
async function executeCourtTool(sock, name, input, sender, chatId) {
  if (name === 'get_court_bookings' || name === 'get_court_reservations') {
    const res = await scvcc.getCourtBookings({ ...input, chatId });
    return res?.message || 'Retrieved court bookings.';
  }
  if (name === 'check_court_availability') {
    const res = await scvcc.checkCourtAvailability({ ...input, chatId });
    return res?.message || 'Checked court availability.';
  }
  if (name === 'book_court') {
    const isSingles = input.partySize === 'Singles';
    const maxNeeded = isSingles ? 2 : 4;
    const defaultRequester = (input.players && input.players.length >= maxNeeded) ? null : sender;
    const res = await scvcc.bookCourt({
      ...input,
      requester: input.requester || defaultRequester,
      requestedBy: sender,
      chatId
    });
    if (res && res.success && res.message) {
      await sendBookingNotifications(sock, chatId, res.message);
    }
    return res?.message || 'Court booked.';
  }
  if (name === 'cancel_court' || name === 'cancel_court_reservation' || name === 'cancel_court_booking') {
    const resId = input.reservationId || input.resId || input.id;
    const res = await scvcc.cancelCourtReservation(resId, chatId);
    if (res && res.success && res.message) {
      await sendBookingNotifications(sock, chatId, res.message);
    }
    return res?.message || 'Could not cancel reservation.';
  }
  if (name === 'get_my_court_bookings') {
    const res = await scvcc.getMyReservations();
    return res?.message || 'Retrieved court reservations.';
  }
  return `Unknown court tool ${name}`;
}

module.exports = {
  sendBookingNotifications,
  handleCourtCommand,
  executeCourtTool
};
