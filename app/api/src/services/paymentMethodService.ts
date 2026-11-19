import type { PaymentMethodRepository, PaymentMethodType } from "../repositories/paymentMethodRepository.js";

export function createPaymentMethodService(paymentMethods: PaymentMethodRepository) {
    return {
        create: (userId: string, type: PaymentMethodType) => paymentMethods.create(userId, type),
        list: (userId: string, activeOnly: boolean) => paymentMethods.list(userId, activeOnly),
    };
}

export type PaymentMethodService = ReturnType<typeof createPaymentMethodService>;
