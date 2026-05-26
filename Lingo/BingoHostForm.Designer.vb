<Global.Microsoft.VisualBasic.CompilerServices.DesignerGenerated()>
Partial Class BingoHostForm
    Inherits System.Windows.Forms.Form

    <System.Diagnostics.DebuggerNonUserCode()>
    Protected Overrides Sub Dispose(disposing As Boolean)
        Try
            If disposing AndAlso components IsNot Nothing Then components.Dispose()
        Finally
            MyBase.Dispose(disposing)
        End Try
    End Sub

    Private components As System.ComponentModel.IContainer

    <System.Diagnostics.DebuggerStepThrough()>
    Private Sub InitializeComponent()
        Me.lblTitle = New System.Windows.Forms.Label()
        Me.lblGameId = New System.Windows.Forms.Label()
        Me.txtGameId = New System.Windows.Forms.TextBox()
        Me.btnNewGame = New System.Windows.Forms.Button()
        Me.btnGeneratePlayers = New System.Windows.Forms.Button()
        Me.txtPlayerName = New System.Windows.Forms.TextBox()
        Me.btnGenerateOne = New System.Windows.Forms.Button()
        Me.btnCallNext = New System.Windows.Forms.Button()
        Me.btnResetCaller = New System.Windows.Forms.Button()
        Me.chkAutoCall = New System.Windows.Forms.CheckBox()
        Me.numAutoSeconds = New System.Windows.Forms.NumericUpDown()
        Me.lblLastCall = New System.Windows.Forms.Label()
        Me.lstCalled = New System.Windows.Forms.ListBox()
        Me.lblWeb = New System.Windows.Forms.Label()
        Me.txtWebUrl = New System.Windows.Forms.TextBox()
        Me.btnCopyUrl = New System.Windows.Forms.Button()
        Me.btnExportHtml = New System.Windows.Forms.Button()
        Me.btnAnnounceChat = New System.Windows.Forms.Button()
        Me.lstCards = New System.Windows.Forms.ListBox()
        Me.autoCallTimer = New System.Windows.Forms.Timer()
        CType(Me.numAutoSeconds, System.ComponentModel.ISupportInitialize).BeginInit()
        Me.SuspendLayout()
        '
        Me.lblTitle.AutoSize = True
        Me.lblTitle.Font = New System.Drawing.Font("Segoe UI", 12.0!, System.Drawing.FontStyle.Bold)
        Me.lblTitle.Location = New System.Drawing.Point(12, 9)
        Me.lblTitle.Name = "lblTitle"
        Me.lblTitle.Size = New System.Drawing.Size(195, 21)
        Me.lblTitle.Text = "Bingo (endgame)"
        '
        Me.lblGameId.AutoSize = True
        Me.lblGameId.Location = New System.Drawing.Point(14, 42)
        Me.lblGameId.Text = "Game ID"
        '
        Me.txtGameId.Location = New System.Drawing.Point(74, 39)
        Me.txtGameId.Size = New System.Drawing.Size(280, 20)
        Me.txtGameId.ReadOnly = True
        '
        Me.btnNewGame.Location = New System.Drawing.Point(360, 37)
        Me.btnNewGame.Size = New System.Drawing.Size(90, 23)
        Me.btnNewGame.Text = "New Game"
        '
        Me.btnGeneratePlayers.Location = New System.Drawing.Point(14, 72)
        Me.btnGeneratePlayers.Size = New System.Drawing.Size(200, 23)
        Me.btnGeneratePlayers.Text = "Generate cards (Lingo players)"
        '
        Me.txtPlayerName.Location = New System.Drawing.Point(220, 74)
        Me.txtPlayerName.Size = New System.Drawing.Size(120, 20)
        '
        Me.btnGenerateOne.Location = New System.Drawing.Point(346, 72)
        Me.btnGenerateOne.Size = New System.Drawing.Size(104, 23)
        Me.btnGenerateOne.Text = "Generate one"
        '
        Me.btnCallNext.Font = New System.Drawing.Font("Segoe UI", 14.0!, System.Drawing.FontStyle.Bold)
        Me.btnCallNext.Location = New System.Drawing.Point(14, 110)
        Me.btnCallNext.Size = New System.Drawing.Size(140, 48)
        Me.btnCallNext.Text = "Call next"
        '
        Me.btnResetCaller.Location = New System.Drawing.Point(160, 122)
        Me.btnResetCaller.Size = New System.Drawing.Size(90, 28)
        Me.btnResetCaller.Text = "Reset balls"
        '
        Me.chkAutoCall.AutoSize = True
        Me.chkAutoCall.Location = New System.Drawing.Point(260, 128)
        Me.chkAutoCall.Text = "Auto-call every"
        '
        Me.numAutoSeconds.Location = New System.Drawing.Point(360, 126)
        Me.numAutoSeconds.Minimum = 3
        Me.numAutoSeconds.Maximum = 120
        Me.numAutoSeconds.Value = 8
        Me.numAutoSeconds.Width = 50
        '
        Me.lblLastCall.Font = New System.Drawing.Font("Segoe UI", 28.0!, System.Drawing.FontStyle.Bold)
        Me.lblLastCall.Location = New System.Drawing.Point(14, 168)
        Me.lblLastCall.Size = New System.Drawing.Size(436, 52)
        Me.lblLastCall.Text = "—"
        Me.lblLastCall.TextAlign = System.Drawing.ContentAlignment.MiddleCenter
        '
        Me.lstCalled.FormattingEnabled = True
        Me.lstCalled.Location = New System.Drawing.Point(14, 228)
        Me.lstCalled.Size = New System.Drawing.Size(200, 160)
        '
        Me.lstCards.FormattingEnabled = True
        Me.lstCards.Location = New System.Drawing.Point(220, 228)
        Me.lstCards.Size = New System.Drawing.Size(230, 160)
        '
        Me.lblWeb.AutoSize = True
        Me.lblWeb.Location = New System.Drawing.Point(14, 398)
        Me.lblWeb.Text = "Player cards URL"
        '
        Me.txtWebUrl.Location = New System.Drawing.Point(14, 415)
        Me.txtWebUrl.Size = New System.Drawing.Size(360, 20)
        Me.txtWebUrl.ReadOnly = True
        '
        Me.btnCopyUrl.Location = New System.Drawing.Point(380, 413)
        Me.btnCopyUrl.Size = New System.Drawing.Size(70, 23)
        Me.btnCopyUrl.Text = "Copy"
        '
        Me.btnExportHtml.Location = New System.Drawing.Point(14, 448)
        Me.btnExportHtml.Size = New System.Drawing.Size(120, 23)
        Me.btnExportHtml.Text = "Export HTML cards"
        '
        Me.btnAnnounceChat.Location = New System.Drawing.Point(140, 448)
        Me.btnAnnounceChat.Size = New System.Drawing.Size(140, 23)
        Me.btnAnnounceChat.Text = "Announce in chat"
        '
        Me.autoCallTimer.Interval = 8000
        '
        Me.ClientSize = New System.Drawing.Size(464, 481)
        Me.Controls.Add(Me.btnAnnounceChat)
        Me.Controls.Add(Me.btnExportHtml)
        Me.Controls.Add(Me.btnCopyUrl)
        Me.Controls.Add(Me.txtWebUrl)
        Me.Controls.Add(Me.lblWeb)
        Me.Controls.Add(Me.lstCards)
        Me.Controls.Add(Me.lstCalled)
        Me.Controls.Add(Me.lblLastCall)
        Me.Controls.Add(Me.numAutoSeconds)
        Me.Controls.Add(Me.chkAutoCall)
        Me.Controls.Add(Me.btnResetCaller)
        Me.Controls.Add(Me.btnCallNext)
        Me.Controls.Add(Me.btnGenerateOne)
        Me.Controls.Add(Me.txtPlayerName)
        Me.Controls.Add(Me.btnGeneratePlayers)
        Me.Controls.Add(Me.btnNewGame)
        Me.Controls.Add(Me.txtGameId)
        Me.Controls.Add(Me.lblGameId)
        Me.Controls.Add(Me.lblTitle)
        Me.FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog
        Me.MaximizeBox = False
        Me.MinimizeBox = False
        Me.Name = "BingoHostForm"
        Me.StartPosition = System.Windows.Forms.FormStartPosition.CenterParent
        Me.Text = "Lingo Bingo"
        CType(Me.numAutoSeconds, System.ComponentModel.ISupportInitialize).EndInit()
        Me.ResumeLayout(False)
        Me.PerformLayout()
    End Sub

    Friend WithEvents lblTitle As Label
    Friend WithEvents lblGameId As Label
    Friend WithEvents txtGameId As TextBox
    Friend WithEvents btnNewGame As Button
    Friend WithEvents btnGeneratePlayers As Button
    Friend WithEvents txtPlayerName As TextBox
    Friend WithEvents btnGenerateOne As Button
    Friend WithEvents btnCallNext As Button
    Friend WithEvents btnResetCaller As Button
    Friend WithEvents chkAutoCall As CheckBox
    Friend WithEvents numAutoSeconds As NumericUpDown
    Friend WithEvents lblLastCall As Label
    Friend WithEvents lstCalled As ListBox
    Friend WithEvents lblWeb As Label
    Friend WithEvents txtWebUrl As TextBox
    Friend WithEvents btnCopyUrl As Button
    Friend WithEvents btnExportHtml As Button
    Friend WithEvents btnAnnounceChat As Button
    Friend WithEvents lstCards As ListBox
    Friend WithEvents autoCallTimer As Timer
End Class
