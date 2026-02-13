
export const COLORS = {
    background: '#0B0F14',
    accent: '#2F80FF',
    card: '#161B22',
    text: '#FFFFFF',
    textSecondary: '#8B949E',
    success: '#2EA043',
    error: '#DA3633',
    border: '#30363D',
};

export const FONTS = {
    bold: 'System', // Use system bold font for now
    regular: 'System', // Use system default
};

export const STYLES = {
    card: {
        backgroundColor: COLORS.card,
        borderRadius: 16,
        padding: 20,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 5,
    },
    title: {
        color: COLORS.text,
        fontSize: 24,
        fontWeight: 'bold',
    },
    subtitle: {
        color: COLORS.textSecondary,
        fontSize: 14,
        marginTop: 4,
    },
    heading: {
        color: COLORS.text,
        fontSize: 18,
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
};
