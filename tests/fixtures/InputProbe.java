import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.MouseWheelEvent;
import javax.swing.JFrame;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;

/**
 * Stand-in for RuneLite in end-to-end tests: a Swing window that prints every
 * mouse and key event it receives, so tests can check what the web app sent.
 */
public class InputProbe {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame("InputProbe");
            JPanel panel = new JPanel() {
                @Override
                protected void paintComponent(Graphics g) {
                    super.paintComponent(g);
                    g.setColor(new Color(0x3b2f1e));
                    g.fillRect(0, 0, getWidth(), getHeight());
                    g.setColor(Color.ORANGE);
                    g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 28));
                    g.drawString("InputProbe " + getWidth() + "x" + getHeight(), 40, 60);
                }
            };
            MouseAdapter mouse = new MouseAdapter() {
                @Override
                public void mousePressed(MouseEvent e) { log("press", e); }

                @Override
                public void mouseReleased(MouseEvent e) { log("release", e); }

                @Override
                public void mouseDragged(MouseEvent e) { log("drag", e); }

                @Override
                public void mouseWheelMoved(MouseWheelEvent e) {
                    System.out.println("wheel " + e.getWheelRotation() + " " + e.getX() + " " + e.getY());
                }
            };
            panel.addMouseListener(mouse);
            panel.addMouseMotionListener(mouse);
            panel.addMouseWheelListener(mouse);
            panel.setFocusable(true);
            panel.addKeyListener(new KeyAdapter() {
                @Override
                public void keyPressed(KeyEvent e) {
                    System.out.println("key " + KeyEvent.getKeyText(e.getKeyCode()) + (e.isShiftDown() ? " shift" : ""));
                }

                @Override
                public void keyTyped(KeyEvent e) {
                    System.out.println("typed " + e.getKeyChar());
                }
            });
            frame.setContentPane(panel);
            frame.setSize(800, 600);
            frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            frame.setVisible(true);
            panel.requestFocusInWindow();
        });
    }

    private static void log(String kind, MouseEvent e) {
        System.out.println(kind + " " + e.getButton() + " " + e.getX() + " " + e.getY()
            + (e.isShiftDown() ? " shift" : ""));
        System.out.flush();
    }
}
